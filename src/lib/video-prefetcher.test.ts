import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeWindow, indexAtTime, VideoPrefetcher } from './video-prefetcher';
import { buildSegmentCacheKey, clearVideoCache, saveCacheSettings } from './video-cache';
import { parseM3u8Playlist } from './m3u8-parse';
import { rewriteM3u8 } from './m3u8';
import * as videoCache from './video-cache';

vi.mock('./db', () => ({ db: { segmentMeta: {
  clear: vi.fn().mockResolvedValue(undefined),
  toArray: vi.fn().mockResolvedValue([]),
} } }));

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await clearVideoCache();
  vi.restoreAllMocks();
});

describe('computeWindow', () => {
  const durations = [4, 4, 4, 4, 4]; // 总长 20s

  it('indexAtTime：累计时长定位分片', () => {
    expect(indexAtTime(durations, 0)).toBe(0);
    expect(indexAtTime(durations, 4.5)).toBe(1);
    expect(indexAtTime(durations, 100)).toBe(4);
  });

  it('有限窗口：从回看点到当前 + horizon', () => {
    // 当前 10s，回看 5s → from 覆盖 5s 处；horizon 6s → to 覆盖 16s 处
    const { fromIdx, toIdx } = computeWindow(durations, 10, 6, 5);
    expect(fromIdx).toBe(1); // 5s 落在第 2 片
    expect(toIdx).toBe(4);   // 16s 落在第 4 片末
  });

  it('horizon = 0：无限铺满到片尾', () => {
    const { fromIdx, toIdx } = computeWindow(durations, 10, 0, 5);
    expect(fromIdx).toBe(1);
    expect(toIdx).toBe(5);
  });

  it('锚点接近片尾时钳制', () => {
    const { toIdx } = computeWindow(durations, 19, 6, 5);
    expect(toIdx).toBe(5);
  });

  it('时长全缺失时按数量兜底，且不越过分片总数', () => {
    expect(computeWindow(new Array(6).fill(0), 0, 6).toIdx).toBe(6);
    // 分片数必须超过兜底上限才钉得住：否则「兜底」与「整集」结果相同，断言落空
    expect(computeWindow(new Array(300).fill(0), 0, 6).toIdx).toBe(200);
    // 无限模式（暂停黄金窗口）对这类源同样收在兜底上限，不再铺满整集
    expect(computeWindow(new Array(300).fill(0), 0, 0).toIdx).toBe(200);
  });
});

describe('VideoPrefetcher.ensure 幂等', () => {
  /** 200 片 × 5s = 1000s：前向余量判定需要窗口明显大于 FORWARD_MARGIN_SECONDS */
  const SEG_COUNT = 200;
  const SEG_BASE = 'https://cdn.example.com/';
  const M3U8_URL = `${SEG_BASE}index.m3u8`;
  const PLAYLIST = [
    '#EXTM3U',
    ...Array.from({ length: SEG_COUNT }, (_, i) => `#EXTINF:5,\n${SEG_BASE}seg${i + 1}.ts`),
  ].join('\n');
  const segUrl = (n: number) => `${SEG_BASE}seg${n}.ts`;

  function deferred() {
    let resolve = () => {};
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  interface MockOptions {
    /** 首次 m3u8 拉取挂起指定毫秒，制造「parsing 在途」的窗口 */
    gateM3u8Ms?: number;
    /** 分片请求全部挂起，让运行稳定停在 running 状态 */
    holdSegments?: boolean;
  }

  function makePrefetcher(opts: MockOptions = {}) {
    const m3u8Fetches = vi.fn();
    const segUrls: string[] = [];
    const hold = deferred();
    let firstM3u8 = true;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('.m3u8')) {
        m3u8Fetches();
        if (firstM3u8 && opts.gateM3u8Ms) {
          firstM3u8 = false;
          await new Promise((r) => setTimeout(r, opts.gateM3u8Ms));
        }
        return new Response(PLAYLIST, { status: 200 });
      }
      segUrls.push(url);
      if (opts.holdSegments) await hold.promise;
      return new Response(new ArrayBuffer(1024), { status: 200 });
    }));
    return { m3u8Fetches, segUrls, release: () => hold.resolve() };
  }

  function ensureAt(pf: VideoPrefetcher, currentTime: number) {
    pf.ensure({ m3u8Url: M3U8_URL, currentTime, episodeKey: 's:v:0', horizonSeconds: 300 });
  }

  it('immediately stops active prefetch when settings are disabled', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) });
    const { segUrls, release } = makePrefetcher({ holdSegments: true });
    const pf = new VideoPrefetcher();
    ensureAt(pf, 0);
    await vi.waitFor(() => expect(segUrls).toHaveLength(1));
    saveCacheSettings({ enabled: false });
    expect(pf.getStats().state).toBe('idle');
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(segUrls).toHaveLength(1);
  });

  it('reparses on ad filtering changes and forwards the selected filter policy', async () => {
    const { m3u8Fetches, release } = makePrefetcher();
    const pf = new VideoPrefetcher();
    ensureAt(pf, 0);
    await vi.waitFor(() => expect(pf.getStats().state).toBe('done'));
    pf.ensure({ m3u8Url: M3U8_URL, currentTime: 0, episodeKey: 's:v:0', adFilter: false });
    await vi.waitFor(() => expect(m3u8Fetches).toHaveBeenCalledTimes(2));
    pf.stop();
    release();
  });

  it('reuses fully cached windows beyond the retry delay without another cache scan', async () => {
    const { m3u8Fetches, release } = makePrefetcher();
    const probe = vi.spyOn(videoCache, 'hasCachedSegment').mockResolvedValue(true);
    const pf = new VideoPrefetcher();
    ensureAt(pf, 0);
    await vi.waitFor(() => expect(pf.getStats().state).toBe('done'));
    const scans = probe.mock.calls.length;
    expect(pf.getStats().cached).toBe(pf.getStats().total);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    ensureAt(pf, 10);
    await Promise.resolve();
    expect(m3u8Fetches).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledTimes(scans);
    pf.stop();
    release();
  });

  it('clearing aborts a playlist request and prevents late segment downloads', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    }));
    const pf = new VideoPrefetcher();
    ensureAt(pf, 0);
    await vi.waitFor(() => expect(signal).toBeDefined());
    await clearVideoCache();
    expect(signal?.aborted).toBe(true);
    expect(pf.getStats().state).toBe('idle');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('defaults to one in-flight background segment request', async () => {
    const { segUrls, release } = makePrefetcher({ holdSegments: true });
    const pf = new VideoPrefetcher();
    ensureAt(pf, 0);
    await vi.waitFor(() => expect(segUrls).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(segUrls).toHaveLength(1);
    pf.stop();
    release();
  });

  it('does not start another request when stopped while throttled', async () => {
    const { segUrls, release } = makePrefetcher();
    const pf = new VideoPrefetcher();
    pf.setThrottled(true);
    ensureAt(pf, 0);
    await vi.waitFor(() => expect(pf.getStats().state).toBe('running'));
    pf.stop();
    pf.setThrottled(false);
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(segUrls).toHaveLength(0);
    expect(pf.getStats().state).toBe('idle');
    release();
  });

  it('parsing 期间同锚点的第二次 ensure 不 abort 刚起跑的运行', async () => {
    const { m3u8Fetches, segUrls, release } = makePrefetcher({ gateM3u8Ms: 30, holdSegments: true });
    const pf = new VideoPrefetcher();

    ensureAt(pf, 0);
    expect(pf.getStats().state).toBe('parsing');
    ensureAt(pf, 0);
    expect(m3u8Fetches).toHaveBeenCalledTimes(1);

    // 复用的是同一次运行：解析完成后照常推进到分片
    await vi.waitFor(() => expect(pf.getStats().state).toBe('running'));
    expect(m3u8Fetches).toHaveBeenCalledTimes(1);
    expect(segUrls[0]).toBe(segUrl(1));

    pf.stop();
    release();
  });

  it('parsing 期间锚点变化必须重建，且窗口按新锚点计算', async () => {
    const { m3u8Fetches, segUrls, release } = makePrefetcher({ gateM3u8Ms: 30, holdSegments: true });
    const pf = new VideoPrefetcher();

    ensureAt(pf, 0);
    // 解析在途时用户拖到 600s：沿用旧锚点会把整个窗口建在片头，且要到队列耗尽才纠正
    ensureAt(pf, 600);
    expect(m3u8Fetches).toHaveBeenCalledTimes(2);

    await vi.waitFor(() => expect(pf.getStats().state).toBe('running'));
    // 优先下载播放头 600s 处第 120 片，再补回看窗口。
    expect(segUrls[0]).toBe(segUrl(120));

    pf.stop();
    release();
  });

  it('running 状态的前向余量按最新播放头判定，不按建窗时的旧值', async () => {
    const { m3u8Fetches, segUrls, release } = makePrefetcher({ holdSegments: true });
    const pf = new VideoPrefetcher();

    ensureAt(pf, 0);
    await vi.waitFor(() => expect(pf.getStats().state).toBe('running'));
    expect(m3u8Fetches).toHaveBeenCalledTimes(1);

    // 窗口 [0, 300]：播放头 100s 仍有 200s 前向余量 → 复用
    ensureAt(pf, 100);
    expect(m3u8Fetches).toHaveBeenCalledTimes(1);

    // 播放头 260s：余量不足 60s → 必须重建（按建窗时的 0s 判定会永远判「够用」）
    ensureAt(pf, 260);
    expect(m3u8Fetches).toHaveBeenCalledTimes(1); // 重建窗口复用清单
    await vi.waitFor(() => expect(segUrls).toContain(segUrl(52)));

    pf.stop();
    release();
  });

  it('done 状态复用窗口与清单；换集重建队列', async () => {
    const { m3u8Fetches, release } = makePrefetcher();
    const pf = new VideoPrefetcher();

    ensureAt(pf, 0);
    await vi.waitFor(() => expect(pf.getStats().state).toBe('done'));
    expect(m3u8Fetches).toHaveBeenCalledTimes(1);

    // done 后窗口仍覆盖当前位置时，既不拉清单也不重新扫描分片。
    ensureAt(pf, 0);
    await vi.waitFor(() => expect(pf.getStats().state).toBe('done'));
    expect(m3u8Fetches).toHaveBeenCalledTimes(1);

    // 换集：descriptor 不同 → 必须重建
    pf.ensure({ m3u8Url: M3U8_URL, currentTime: 0, episodeKey: 's:v:1', horizonSeconds: 300 });
    await vi.waitFor(() => expect(pf.getStats().state).toBe('done'));
    expect(m3u8Fetches).toHaveBeenCalledTimes(2);
    release();
  });
});

describe('缓存 key 归一（代理形态根相对地址）', () => {
  const APP = 'https://app.example.com';
  const UPSTREAM = 'https://cdn.example.com/live/index.m3u8';
  const MANIFEST = `/api/proxy?url=${encodeURIComponent(UPSTREAM)}`;

  beforeEach(() => {
    vi.stubGlobal('document', { baseURI: `${APP}/watch` });
  });

  it('同一分片的相对形式与绝对形式收敛为同一个 key', () => {
    const rel = '/api/proxy?url=https%3A%2F%2Fcdn.example.com%2Flive%2Fseg1.ts';
    expect(buildSegmentCacheKey(rel)).toBe(buildSegmentCacheKey(`${APP}${rel}`));
  });

  it('代理回退下预取解析出的分片地址与 hls.js 解析同一行完全一致', async () => {
    // 服务端 /api/proxy 下发给播放器的正是这个改写后的 body（分片为本站根相对地址）
    const proxied = rewriteM3u8('#EXTM3U\n#EXTINF:5,\nseg1.ts', UPSTREAM);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(proxied, { status: 200 })));

    const parsed = await parseM3u8Playlist(MANIFEST);
    const loaderUrl = new URL(proxied.split('\n')[2], `${APP}${MANIFEST}`).href;

    expect(parsed.segments[0].url).toBe(loaderUrl);
  });
});
