import { fetchSegment, shareSegmentRequest } from './segment-request';
import { parseM3u8Playlist, type ParsedPlaylist } from './m3u8-parse';
import {
  buildSegmentCacheKey,
  hasCachedSegment,
  loadCacheSettings,
  putCachedSegmentResilient,
  enforceQuota,
  ensurePersistentStorage,
  getCacheRevision,
  getCacheEvictionVersion,
  onCacheInvalidated,
  setPlaybackCacheWindow,
  type CacheSettings,
} from './video-cache';

/**
 * 前向片段预取器。
 *
 * 设计要点（这是「视频暂停也继续缓存」的全部秘密）：
 *   预取循环体内**不读取任何播放状态**——不判断 paused、不判断 document.hidden、
 *   不听播放器事件。循环体只有 fetch 与 cache 写入，因此视频暂停、页面切到
 *   后台标签页时，队列仍会继续推进。
 *
 *   `setThrottled()` 是「临时让出带宽」（播放卡顿时由调用方触发），与
 *   「暂停视频就停缓存」是两件事，不要混用。
 *
 * 窗口语义：
 *   - horizonSeconds > 0：从当前播放位置向前铺 horizonSeconds 秒，另回看 30s；
 *   - horizonSeconds = 0：无限模式，铺满到片尾（配额交给字节上限 + LRU）。
 */

export type PrefetchState = 'idle' | 'parsing' | 'running' | 'done' | 'error' | 'disabled';

export interface PrefetchStats {
  state: PrefetchState;
  cached: number;
  total: number;
  bytes: number;
  message?: string;
}

export interface PrefetchOptions {
  /** 当前集 m3u8 地址（与播放器 loadSource 一致，直接直连或代理改写形式均可） */
  m3u8Url: string;
  currentTime: number;
  /** 剧集标识 `${source}:${vodId}:${episodeIndex}`（LRU 按集淘汰的分组键） */
  episodeKey: string;
  /** 覆盖 CacheSettings.horizonSeconds；0 = 无限铺满（暂停黄金窗口使用） */
  horizonSeconds?: number;
  lookBehindSeconds?: number;
  concurrency?: number;
  adFilter?: boolean;
  preferredHeight?: number;
  protectPlayback?: boolean;
  onProgress?: (stats: PrefetchStats) => void;
}

interface RunDescriptor {
  m3u8Url: string;
  episodeKey: string;
  horizonSeconds: number;
  adFilter: boolean;
  preferredHeight?: number;
  revision: number;
}

/** 前向余量：正在跑的窗口距播放位置还有 60s 以上时，ensure 不重建 */
const FORWARD_MARGIN_SECONDS = 60;
/** parsing 期间视为「锚点未变」的容差：恢复进度等场景下 seek 目标与读到的播放头会差一点 */
const ANCHOR_EPSILON_SECONDS = 1;
const LOOK_BEHIND_SECONDS_DEFAULT = 30;
/** 时长缺失时的兜底窗口（分片数） */
const FALLBACK_MAX_SEGMENTS = 200;
const PROGRESS_EMIT_INTERVAL_MS = 250;

/** 纯函数：按累计时长定位时间点对应的分片下标（第一个「累计结束 ≥ t」的分片） */
export function indexAtTime(durations: number[], time: number): number {
  let acc = 0;
  for (let i = 0; i < durations.length; i++) {
    acc += durations[i];
    if (acc >= time) return i;
  }
  return Math.max(0, durations.length - 1);
}

/**
 * 纯函数：计算预取窗口 [fromIdx, toIdx)（左闭右开）。
 * horizonSeconds = 0 表示无限（铺到片尾）；时长全缺失时按 FALLBACK_MAX_SEGMENTS 兜底。
 */
export function computeWindow(
  durations: number[],
  currentTime: number,
  horizonSeconds: number,
  lookBehindSeconds = LOOK_BEHIND_SECONDS_DEFAULT
): { fromIdx: number; toIdx: number } {
  const total = durations.reduce((s, d) => s + d, 0);
  const cur = Math.max(0, Math.min(currentTime, total));
  const fromIdx = indexAtTime(durations, Math.max(0, cur - lookBehindSeconds));
  // 时长数据不可信（全 0，累计时长恒为 0）时按数量兜底，避免无限窗口
  if (total === 0) {
    return { fromIdx, toIdx: Math.min(durations.length, fromIdx + FALLBACK_MAX_SEGMENTS) };
  }
  if (horizonSeconds <= 0) return { fromIdx, toIdx: durations.length };
  const toTime = Math.min(total, cur + horizonSeconds);
  const toIdx = Math.min(durations.length, indexAtTime(durations, toTime) + 1);
  return { fromIdx, toIdx };
}

export function shouldPrefetch(): boolean {
  const conn = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (!conn) return true;
  if (conn.saveData) return false;
  if (conn.effectiveType && /^(slow-)?2g$/.test(conn.effectiveType)) return false;
  return true;
}

interface PrefetchTask { url: string; index: number }
interface PrefetchRun {
  options: PrefetchOptions;
  settings: CacheSettings;
  descriptor: RunDescriptor;
  generation: number;
  signal: AbortSignal;
  tasks: PrefetchTask[];
  cursor: number;
  cached: number;
  bytes: number;
}

export class VideoPrefetcher {
  private generation = 0;
  private abort = new AbortController();
  private throttled = false;
  private parsed?: { url: string; adFilter: boolean; preferredHeight?: number; value: ParsedPlaylist };
  private unsubscribe?: () => void;
  private completedAt = 0;
  private completedEvictionVersion = 0;
  private budgetLimited = false;
  private stats: PrefetchStats = { state: 'idle', cached: 0, total: 0, bytes: 0 };
  private onProgress?: (stats: PrefetchStats) => void;
  private lastEmit = 0;
  private descriptor?: RunDescriptor;
  private currentTime = 0;
  private windowFromTime = 0;
  private windowToTime = 0;
  private playlistEndTime = 0;

  /** 幂等入口；入参包括真实媒体清单、播放头和过滤设置，完成窗口仍覆盖时不重复扫描。 */
  ensure(options: PrefetchOptions): void {
    const settings = loadCacheSettings();
    if (!settings.enabled || !shouldPrefetch()) {
      this.stop();
      this.setState({ state: 'disabled', cached: 0, total: 0, bytes: 0 });
      return;
    }
    this.unsubscribe ??= onCacheInvalidated(() => this.stop());
    const descriptor: RunDescriptor = {
      m3u8Url: options.m3u8Url, episodeKey: options.episodeKey,
      horizonSeconds: options.horizonSeconds ?? settings.horizonSeconds,
      adFilter: options.adFilter ?? true, preferredHeight: options.preferredHeight,
      revision: getCacheRevision(),
    };
    if (this.matchesParsed(descriptor)) this.protectWindow(options, this.parsed!.value);
    if (!this.canReuse(options, descriptor)) void this.run(options, settings, descriptor);
  }

  /** 停止并取消订阅；失效回调可同步调用，迟到结果不能更新新任务。 */
  stop(): void {
    this.generation += 1;
    this.abort.abort();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.parsed = undefined;
    this.descriptor = undefined;
    this.setState({ state: 'idle', cached: 0, total: 0, bytes: 0 });
  }

  /** 入参为是否让出带宽；不取消仍被播放请求共享的底层下载。 */
  setThrottled(value: boolean): void { this.throttled = value; }

  /** 返回当前窗口的缓存进度快照。 */
  getStats(): PrefetchStats { return this.stats; }

  /** 复用必须同集、同档位、同过滤配置；失败窗口短暂退避，淘汰后强制重新检查。 */
  private canReuse(options: PrefetchOptions, descriptor: RunDescriptor): boolean {
    const sameRun = this.descriptor && Object.keys(descriptor).every((key) =>
      this.descriptor![key as keyof RunDescriptor] === descriptor[key as keyof RunDescriptor]);
    if (!sameRun) return false;
    if (this.stats.state === 'parsing') return Math.abs(options.currentTime - this.currentTime) < ANCHOR_EPSILON_SECONDS;
    const completed = this.stats.state === 'done' && this.completedEvictionVersion === getCacheEvictionVersion() &&
      (this.budgetLimited || this.stats.cached === this.stats.total || Date.now() - this.completedAt < 30_000);
    const coversEnd = this.windowToTime >= this.playlistEndTime && options.currentTime <= this.windowToTime;
    return (this.stats.state === 'running' || completed) && options.currentTime >= this.windowFromTime &&
      (coversEnd || options.currentTime + FORWARD_MARGIN_SECONDS < this.windowToTime);
  }

  /** 限制进度通知频率；状态切换立即通知。 */
  private setState(next: PrefetchStats): void {
    this.stats = next;
    const now = Date.now();
    if (now - this.lastEmit >= PROGRESS_EMIT_INTERVAL_MS || next.state !== 'running') {
      this.lastEmit = now;
      this.onProgress?.(next);
    }
  }

  /** 等待带宽恢复；signal 取消立即退出，不留下轮询定时器。 */
  private async waitForResume(run: PrefetchRun): Promise<void> {
    while (this.throttled && !run.signal.aborted) {
      await new Promise<void>((resolve) => {
        const finish = () => { clearTimeout(timer); run.signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, 250);
        run.signal.addEventListener('abort', finish, { once: true });
        if (run.signal.aborted) finish();
      });
    }
  }

  /** 当前集保护播放头前后窗口；下一集预取不得覆盖这一保护状态。 */
  private protectWindow(options: PrefetchOptions, parsed: ParsedPlaylist): void {
    if (!options.protectPlayback) return;
    const durations = parsed.segments.map((segment) => segment.duration);
    const { fromIdx, toIdx } = computeWindow(durations, options.currentTime, 60, 30);
    setPlaybackCacheWindow({
      episodeKey: options.episodeKey, currentIndex: indexAtTime(durations, options.currentTime) + 1,
      protectedKeys: new Set(parsed.segments.slice(fromIdx, toIdx).map((segment) => buildSegmentCacheKey(segment.url))),
    });
  }

  /** 检查解析缓存；仅复用地址、档位偏好和过滤配置均相同的清单。 */
  private matchesParsed(descriptor: RunDescriptor): boolean {
    return this.parsed?.url === descriptor.m3u8Url && this.parsed.adFilter === descriptor.adFilter &&
      this.parsed.preferredHeight === descriptor.preferredHeight;
  }

  /** 同一运行复用解析结果；切源、过滤变化、清理后失效，网络请求可取消。 */
  private async parsePlaylist(descriptor: RunDescriptor, signal: AbortSignal): Promise<ParsedPlaylist> {
    if (this.matchesParsed(descriptor)) return this.parsed!.value;
    const value = await parseM3u8Playlist(descriptor.m3u8Url, 0, descriptor.preferredHeight, {
      stripLeadAd: descriptor.adFilter, signal,
    });
    if (!signal.aborted && descriptor === this.descriptor) {
      this.parsed = { url: descriptor.m3u8Url, adFilter: descriptor.adFilter, preferredHeight: descriptor.preferredHeight, value };
    }
    return value;
  }

  /** 创建窗口队列；播放头前向优先，回看最后补齐，避免拖动后先下载旧分片。 */
  private buildQueue(options: PrefetchOptions, parsed: ParsedPlaylist, horizon: number): PrefetchTask[] {
    const durations = parsed.segments.map((segment) => segment.duration);
    const { fromIdx, toIdx } = computeWindow(durations, options.currentTime, horizon, options.lookBehindSeconds);
    this.windowFromTime = durations.slice(0, fromIdx).reduce((sum, duration) => sum + duration, 0);
    this.windowToTime = durations.slice(0, toIdx).reduce((sum, duration) => sum + duration, 0);
    this.playlistEndTime = parsed.totalDuration;
    const current = Math.max(fromIdx, indexAtTime(durations, options.currentTime));
    const indices = [...Array.from({ length: toIdx - current }, (_, index) => current + index),
      ...Array.from({ length: current - fromIdx }, (_, index) => current - index - 1)];
    const seen = new Set<string>();
    return indices.map((index) => ({ url: parsed.segments[index].url, index: index + 1 })).filter((task) => {
      const key = buildSegmentCacheKey(task.url);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** 启动一轮窗口；异步结果均核对代次，错误不影响播放器本身。 */
  private async run(options: PrefetchOptions, settings: CacheSettings, descriptor: RunDescriptor): Promise<void> {
    const generation = ++this.generation;
    this.abort.abort();
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.onProgress = options.onProgress;
    if (this.descriptor?.episodeKey !== descriptor.episodeKey) this.parsed = undefined;
    this.descriptor = descriptor;
    this.currentTime = options.currentTime;
    this.budgetLimited = false;
    this.setState({ state: 'parsing', cached: 0, total: 0, bytes: 0 });
    void ensurePersistentStorage();
    try {
      const parsed = await this.parsePlaylist(descriptor, signal);
      if (generation !== this.generation) return;
      if (parsed.byterange) throw new Error('该集使用 BYTERANGE 分片，不支持本地缓存');
      this.protectWindow(options, parsed);
      const tasks = this.buildQueue(options, parsed, descriptor.horizonSeconds);
      const run: PrefetchRun = { options, settings, descriptor, generation, signal, tasks, cursor: 0, cached: 0, bytes: 0 };
      this.emitRun(run);
      const concurrency = Math.max(1, Math.min(options.concurrency ?? 1, 4));
      await Promise.all(Array.from({ length: concurrency }, () => this.worker(run)));
      if (generation !== this.generation) return;
      await enforceQuota(settings);
      if (generation === this.generation) this.finishRun(run);
    } catch (error) {
      if (generation !== this.generation) return;
      this.setState({ state: 'error', cached: 0, total: 0, bytes: 0,
        message: error instanceof Error ? error.message : '预取失败' });
    }
  }

  /** 下载单分片；先查磁盘，再复用共享网络，写入带下载开始时的缓存版本。 */
  private async cacheTask(run: PrefetchRun, task: PrefetchTask): Promise<{ result: string; bytes: number }> {
    const key = buildSegmentCacheKey(task.url);
    if (await hasCachedSegment(key)) return { result: 'ok', bytes: 0 };
    if (run.signal.aborted) return { result: 'failed', bytes: 0 };
    const fragment = await shareSegmentRequest(key, run.signal, (signal) => fetchSegment(task.url, signal));
    if (run.signal.aborted) return { result: 'failed', bytes: 0 };
    const result = await putCachedSegmentResilient(key, fragment.data, {
      episodeKey: run.options.episodeKey, index: task.index, costMs: fragment.costMs,
      settings: run.settings, revision: run.descriptor.revision, background: true,
    });
    return { result, bytes: result === 'ok' ? fragment.data.byteLength : 0 };
  }

  /** 消费队列；单片失败继续，预算不足停止扩窗，禁止下载-淘汰循环。 */
  private async worker(run: PrefetchRun): Promise<void> {
    while (run.cursor < run.tasks.length && run.generation === this.generation) {
      await this.waitForResume(run);
      if (run.generation !== this.generation) return;
      const task = run.tasks[run.cursor++];
      if (!task) return;
      try {
        const value = await this.cacheTask(run, task);
        if (run.generation !== this.generation) return;
        if (value.result === 'quota') {
          this.budgetLimited = true;
          this.generation += 1;
          this.abort.abort();
          this.finishRun(run, '已达到缓存预算，已停止预取');
          return;
        }
        if (value.result === 'ok') { run.cached += 1; run.bytes += value.bytes; }
        this.emitRun(run);
      } catch {
        if (run.generation !== this.generation) return;
      }
    }
  }

  /** 输出运行中进度；入参为当前代次的累计计数。 */
  private emitRun(run: PrefetchRun): void {
    this.setState({ state: 'running', cached: run.cached, total: run.tasks.length, bytes: run.bytes });
  }

  /** 保存完成版本和重试时间；空间不足不能触发下一集预热。 */
  private finishRun(run: PrefetchRun, message?: string): void {
    this.completedAt = Date.now();
    this.completedEvictionVersion = getCacheEvictionVersion();
    this.setState({ state: 'done', cached: run.cached, total: run.tasks.length, bytes: run.bytes,
      message: message ?? (run.cached < run.tasks.length ? '部分分片未缓存（源不可达或存储受限）' : undefined) });
  }
}

/** 全站单例：当前集预取。 */
let currentPrefetcher: VideoPrefetcher | undefined;
export function getVideoPrefetcher(): VideoPrefetcher {
  currentPrefetcher ??= new VideoPrefetcher();
  return currentPrefetcher;
}

/** 独立单例：下一集预热，不打断当前集窗口。 */
let nextEpisodePrefetcher: VideoPrefetcher | undefined;
export function getNextEpisodePrefetcher(): VideoPrefetcher {
  nextEpisodePrefetcher ??= new VideoPrefetcher();
  return nextEpisodePrefetcher;
}
