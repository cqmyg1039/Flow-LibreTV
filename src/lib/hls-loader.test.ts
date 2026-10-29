import Hls from 'hls.js';
import type { HlsConfig, LoaderCallbacks, LoaderConfiguration, LoaderContext } from 'hls.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHlsLoader } from './hls-loader';
import { shareSegmentRequest } from './segment-request';

const CACHE = vi.hoisted(() => ({
  enabled: true, read: vi.fn(), put: vi.fn(), touch: vi.fn(),
}));
vi.mock('./video-cache', () => ({
  buildSegmentCacheKey: (url: string) => url,
  getCacheRevision: () => 1,
  loadCacheSettings: () => ({ enabled: CACHE.enabled }),
  readCachedSegment: CACHE.read, putCachedSegmentResilient: CACHE.put, touchMeta: CACHE.touch,
}));

class FakeLoader {
  static load = vi.fn();
  stats = { loading: {}, loaded: 0, total: 0 };
  context: LoaderContext | null = null;
  load(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>) {
    FakeLoader.load(context, config, callbacks);
  }
  abort() {}
  destroy() {}
}

/** 构造 hls.js 默认的 0/0 范围分片上下文，避免误判普通分片为 BYTERANGE。 */
function context(url: string): LoaderContext {
  return { type: 'media-fragment', url, responseType: 'arraybuffer', rangeStart: 0, rangeEnd: 0, frag: {} } as unknown as LoaderContext;
}
/** 使用替代底层 loader，验证缓存和共享逻辑而不发真实网络。 */
function setup() {
  const Ctor = createHlsLoader({ DefaultConfig: { loader: FakeLoader } } as unknown as typeof Hls, {
    getCacheContext: () => ({ episodeKey: 'episode', index: 1 }),
  });
  const loader = new Ctor({} as HlsConfig);
  const callbacks = { onSuccess: vi.fn(), onError: vi.fn(), onTimeout: vi.fn() };
  return { loader, callbacks };
}

beforeEach(() => {
  vi.clearAllMocks();
  CACHE.enabled = true;
  CACHE.read.mockResolvedValue(null);
  CACHE.put.mockResolvedValue('ok');
  FakeLoader.load.mockImplementation((ctx: LoaderContext, _config: unknown, callbacks: LoaderCallbacks<LoaderContext>) => {
    callbacks.onSuccess({ url: ctx.url, data: new ArrayBuffer(8) }, {} as never, ctx, null);
  });
});
afterEach(() => vi.restoreAllMocks());

describe('cache first HLS loader', () => {
  it('writes playback network results without treating zero ranges as BYTERANGE', async () => {
    const { loader, callbacks } = setup();
    loader.load(context('network'), {} as LoaderConfiguration, callbacks);
    await vi.waitFor(() => expect(callbacks.onSuccess).toHaveBeenCalledOnce());
    expect(FakeLoader.load).toHaveBeenCalledOnce();
    expect(CACHE.put).toHaveBeenCalledWith('network', expect.any(ArrayBuffer), expect.objectContaining({ episodeKey: 'episode', revision: 1 }));
  });
  it('serves disk hits without rewriting or downloading them', async () => {
    CACHE.read.mockResolvedValue({ data: new ArrayBuffer(4), costMs: 120 });
    const { loader, callbacks } = setup();
    loader.load(context('disk'), {} as LoaderConfiguration, callbacks);
    await vi.waitFor(() => expect(callbacks.onSuccess).toHaveBeenCalledOnce());
    expect(FakeLoader.load).not.toHaveBeenCalled();
    expect(CACHE.put).not.toHaveBeenCalled();
    expect(loader.stats.loaded).toBe(4);
  });
  it('joins prefetch and survives cancellation of only the prefetch consumer', async () => {
    let complete!: (value: { data: ArrayBuffer; costMs: number }) => void;
    const pending = new Promise<{ data: ArrayBuffer; costMs: number }>((resolve) => { complete = resolve; });
    const controller = new AbortController();
    const prefetch = shareSegmentRequest('overlap', controller.signal, () => pending);
    const rejected = expect(prefetch).rejects.toMatchObject({ name: 'AbortError' });
    const { loader, callbacks } = setup();
    loader.load(context('overlap'), {} as LoaderConfiguration, callbacks);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await rejected;
    complete({ data: new ArrayBuffer(16), costMs: 200 });
    await vi.waitFor(() => expect(callbacks.onSuccess).toHaveBeenCalledOnce());
    expect(FakeLoader.load).not.toHaveBeenCalled();
  });
  it('suppresses late cache callbacks after abort', async () => {
    const { loader, callbacks } = setup();
    loader.load(context('aborted'), {} as LoaderConfiguration, callbacks);
    loader.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(callbacks.onSuccess).not.toHaveBeenCalled();
    expect(FakeLoader.load).not.toHaveBeenCalled();
  });
  it('preserves native loading for explicit byte ranges and disabled caching', () => {
    const { loader, callbacks } = setup();
    loader.load({ ...context('ranged'), rangeEnd: 100 }, {} as LoaderConfiguration, callbacks);
    CACHE.enabled = false;
    setup().loader.load(context('disabled'), {} as LoaderConfiguration, callbacks);
    expect(FakeLoader.load).toHaveBeenCalledTimes(2);
    expect(CACHE.read).not.toHaveBeenCalled();
  });
});
