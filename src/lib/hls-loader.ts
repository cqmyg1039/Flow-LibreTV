import type HlsType from 'hls.js';
import type { HlsConfig, Loader, LoaderCallbacks, LoaderConfiguration, LoaderContext } from 'hls.js';

import { stripAdGroups } from './m3u8';
import { shareSegmentRequest } from './segment-request';
import {
  buildSegmentCacheKey, getCacheRevision, loadCacheSettings,
  putCachedSegmentResilient, readCachedSegment, touchMeta, type CachedFragment,
} from './video-cache';

export interface LoaderOptions {
  blockAd?: boolean;
  onProbe?: (hit: boolean) => void;
  getCacheContext?: (url: string) => { episodeKey: string; index: number } | undefined;
}

type HlsLoaderCtor = new (config: HlsConfig) => Loader<LoaderContext>;

class SegmentLoadError extends Error {
  constructor(message: string, readonly code = 0, readonly timeout = false) {
    super(message);
  }
}

/** 独立底层 loader 保留 hls.js 超时/重试；共享消费者取消不会误销毁其他人的下载。 */
function loadNetwork(
  Base: HlsLoaderCtor, initialConfig: HlsConfig, context: LoaderContext,
  config: LoaderConfiguration, signal: AbortSignal,
): Promise<CachedFragment> {
  const loader = new Base(initialConfig);
  let cancel = () => {};
  const result = new Promise<CachedFragment>((resolve, reject) => {
    const start = performance.now();
    cancel = () => { loader.abort(); reject(new DOMException('Aborted', 'AbortError')); };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    loader.load(context, config, {
      onSuccess: (response) => {
        if (response.data instanceof ArrayBuffer) resolve({ data: response.data, costMs: Math.max(1, performance.now() - start) });
        else reject(new SegmentLoadError('分片响应不是二进制数据'));
      },
      onError: (error) => reject(new SegmentLoadError(error.text, error.code)),
      onTimeout: () => reject(new SegmentLoadError('分片加载超时', 0, true)),
    });
  });
  return result.finally(() => { signal.removeEventListener('abort', cancel); loader.destroy(); });
}

/** 缓存/共享下载合成正常耗时，避免把磁盘命中误当无限网络带宽。 */
function applyFragmentStats(loader: Loader<LoaderContext>, result: CachedFragment): void {
  const now = performance.now();
  Object.assign(loader.stats, {
    loading: { start: now - result.costMs, first: now - result.costMs + 1, end: now },
    total: result.data.byteLength, loaded: result.data.byteLength,
  });
}

/** 组合广告过滤、cache-first 与共享分片；非分片/范围/渐进请求保持原生加载行为。 */
export function createHlsLoader(HlsCtor: typeof HlsType, options: LoaderOptions = {}): HlsLoaderCtor {
  const Base = HlsCtor.DefaultConfig.loader;
  return class CacheFirstHlsLoader extends Base {
    private cancelled = false;
    private controller = new AbortController();
    private pendingCallbacks?: LoaderCallbacks<LoaderContext>;

    constructor(private readonly initialConfig: HlsConfig) { super(initialConfig); }

    load(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>): void {
      this.context = context;
      if (context.type === 'manifest' || context.type === 'level') {
        super.load(context, config, { ...callbacks, onSuccess: (response, stats, ctx, details) => {
          if (options.blockAd && typeof response.data === 'string') response.data = stripAdGroups(response.data);
          if (!this.cancelled) callbacks.onSuccess(response, stats, ctx, details);
        } });
        return;
      }
      const settings = loadCacheSettings();
      const cacheContext = options.getCacheContext?.(context.url);
      const ranged = (context.rangeStart ?? 0) > 0 || (context.rangeEnd ?? 0) > 0;
      if (!settings.enabled || !cacheContext || !('frag' in context) || ('part' in context && context.part) || ranged || context.progressData || this.initialConfig.progressive) {
        super.load(context, config, callbacks);
        return;
      }
      this.pendingCallbacks = callbacks;
      const revision = getCacheRevision();
      const key = buildSegmentCacheKey(context.url);
      const producer = (signal: AbortSignal) => loadNetwork(Base, this.initialConfig, context, config, signal);
      void this.loadFragment(key, producer).then((result) => {
        if (this.cancelled) return;
        this.pendingCallbacks = undefined;
        applyFragmentStats(this, result);
        // 回调可能将 ArrayBuffer 转移给 worker，必须提前复制缓存副本。
        if (!result.cached) void putCachedSegmentResilient(key, result.data.slice(0), { ...cacheContext, settings, revision, costMs: result.costMs });
        callbacks.onSuccess({ url: context.url, data: result.data }, this.stats, context, null);
      }).catch((error: unknown) => {
        if (this.cancelled) return;
        this.pendingCallbacks = undefined;
        if (error instanceof SegmentLoadError && error.timeout) callbacks.onTimeout(this.stats, context, null);
        else callbacks.onError({ code: error instanceof SegmentLoadError ? error.code : 0, text: error instanceof Error ? error.message : '分片加载失败' }, context, null, this.stats);
      });
    }

    /** 先查磁盘再加入共享下载；命中刷新 LRU，不单独重发网络。 */
    private async loadFragment(key: string, producer: (signal: AbortSignal) => Promise<CachedFragment>): Promise<CachedFragment & { cached: boolean }> {
      const hit = await readCachedSegment(key);
      if (this.cancelled) throw new DOMException('Aborted', 'AbortError');
      options.onProbe?.(!!hit);
      if (hit) { void touchMeta(key); return { ...hit, cached: true }; }
      return { ...await shareSegmentRequest(key, this.controller.signal, producer), cached: false };
    }

    /** 显式取消通知 hls.js 释放挂起请求；销毁或成功回调后不重复通知。 */
    abort(): void {
      this.cancelled = true;
      this.controller.abort();
      const callbacks = this.pendingCallbacks;
      this.pendingCallbacks = undefined;
      this.stats.aborted = true;
      if (this.context) callbacks?.onAbort?.(this.stats, this.context, null);
      super.abort();
    }

    /** 销毁仅释放本消费者；共享下载仍有消费者时保持网络连接。 */
    destroy(): void {
      this.cancelled = true;
      this.pendingCallbacks = undefined;
      this.controller.abort();
      super.destroy();
    }
  };
}
