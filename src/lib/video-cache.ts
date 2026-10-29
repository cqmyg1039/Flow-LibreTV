import { db } from './db';
import { documentBaseURI } from './m3u8';
import { planCacheEviction, type PlaybackCacheWindow } from './video-cache-policy';

/** Cache Storage 分片与 IndexedDB 元数据；所有修改串行执行，失效版本阻止迟到写入。 */
export const VIDEO_CACHE_NAME = 'libretv-video-v1';
const META_FLUSH_DEBOUNCE_MS = 30_000;

let revision = 0;
let evictionVersion = 0;
let mutationQueue: Promise<unknown> = Promise.resolve();
let playbackWindow: PlaybackCacheWindow | undefined;
const invalidationListeners = new Set<() => void>();

/** 获取淘汰版本；完成窗口在分片被淘汰后必须重新检查。 */
export function getCacheEvictionVersion(): number {
  return evictionVersion;
}

/** 获取缓存版本；下载开始时捕获，关闭/清理后禁止旧结果写回。 */
export function getCacheRevision(): number {
  return revision;
}

/** 订阅生命周期失效；入参为停止后台任务的回调，返回取消订阅函数。 */
export function onCacheInvalidated(listener: () => void): () => void {
  invalidationListeners.add(listener);
  return () => { invalidationListeners.delete(listener); };
}

/** 更新当前播放窗口；保护附近分片，较远的未来缓存可被播放请求置换。 */
export function setPlaybackCacheWindow(window?: PlaybackCacheWindow): void {
  playbackWindow = window;
}

/** 串行修改 Cache Storage 和元数据；失败不阻塞后续操作。 */
function serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation);
  mutationQueue = result.catch(() => undefined);
  return result;
}

/** 使在途缓存写入失效，并同步通知预取器停止。 */
function invalidateCache(): void {
  revision += 1;
  for (const listener of invalidationListeners) listener();
}

export interface CacheSettings {
  enabled: boolean;
  /** 前向预取窗口（秒）：从当前播放位置铺到多远；0 = 无限铺满到片尾 */
  horizonSeconds: number;
  /** 单集缓存上限（字节） */
  maxBytesPerEpisode: number;
  /** 全局缓存上限（字节） */
  maxTotalBytes: number;
}

export const DEFAULT_CACHE_SETTINGS: CacheSettings = {
  enabled: true,
  horizonSeconds: 300,
  maxBytesPerEpisode: 800 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
};

const SETTINGS_KEY = 'libretv-video-cache-settings';

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function normalizeCacheSettings(input: unknown): CacheSettings {
  const raw = (input ?? {}) as Partial<CacheSettings>;
  return {
    enabled: raw.enabled !== false,
    // 0 = 无限（铺满到片尾）；否则 60s ~ 7200s
    horizonSeconds: raw.horizonSeconds === 0 ? 0 : clamp(raw.horizonSeconds ?? DEFAULT_CACHE_SETTINGS.horizonSeconds, 60, 7200),
    maxBytesPerEpisode: clamp(raw.maxBytesPerEpisode ?? DEFAULT_CACHE_SETTINGS.maxBytesPerEpisode, 50 * 1024 * 1024, 8 * 1024 * 1024 * 1024),
    maxTotalBytes: clamp(raw.maxTotalBytes ?? DEFAULT_CACHE_SETTINGS.maxTotalBytes, 100 * 1024 * 1024, 20 * 1024 * 1024 * 1024),
  };
}

export function loadCacheSettings(): CacheSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return normalizeCacheSettings(raw ? JSON.parse(raw) : undefined);
  } catch {
    return { ...DEFAULT_CACHE_SETTINGS };
  }
}

export function saveCacheSettings(next: Partial<CacheSettings>): CacheSettings {
  const merged = normalizeCacheSettings({ ...loadCacheSettings(), ...next });
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
  } catch { /* 隐私模式等场景忽略 */ }
  invalidateCache();
  return merged;
}

/**
 * 分片缓存 key：归一化成绝对地址（两侧一致，缓存命中的前提）。
 * 以文档基址作基线，本站根相对的代理形式与绝对形式才会收敛到同一个串。
 */
export function buildSegmentCacheKey(segmentUrl: string): string {
  try {
    return new URL(segmentUrl, documentBaseURI()).href;
  } catch {
    return segmentUrl;
  }
}

function cacheStore(): CacheStorage | undefined {
  return typeof caches !== 'undefined' ? caches : undefined;
}

/** 请求持久化存储（避免浏览器在磁盘压力下清掉缓存；失败静默，不影响功能） */
export async function ensurePersistentStorage(): Promise<void> {
  try {
    if (navigator.storage?.persist) await navigator.storage.persist();
  } catch { /* 忽略 */ }
}

export async function hasCachedSegment(key: string): Promise<boolean> {
  const store = cacheStore();
  if (!store) return false;
  try {
    const cache = await store.open(VIDEO_CACHE_NAME);
    const hit = await cache.match(key);
    return !!hit;
  } catch {
    return false;
  }
}

export interface CachedFragment {
  data: ArrayBuffer;
  /** 预取时记录的真实耗时（毫秒），供 loader 合成 hls.js stats */
  costMs: number;
}

export async function readCachedSegment(key: string): Promise<CachedFragment | null> {
  const store = cacheStore();
  if (!store) return null;
  try {
    const cache = await store.open(VIDEO_CACHE_NAME);
    const hit = await cache.match(key);
    if (!hit) return null;
    const data = await hit.arrayBuffer();
    const meta = await db.segmentMeta.get(key);
    return { data, costMs: meta?.costMs ?? 150 };
  } catch {
    return null;
  }
}

export type CachePutResult = 'ok' | 'quota' | 'failed';

export interface CacheWriteOptions {
  episodeKey: string;
  index: number;
  costMs: number;
  settings: CacheSettings;
  revision?: number;
  background?: boolean;
}

/** 删除分片及元数据；入参为已打开的缓存和待删 key。 */
async function removeSegments(cache: Cache, keys: string[]): Promise<void> {
  if (keys.length) evictionVersion += 1;
  for (const key of keys) {
    await cache.delete(key);
    await db.segmentMeta.delete(key);
    touchTimers.delete(key);
  }
}

/** 单次队列内写入；元数据失败时回滚分片，避免不可统计的孤儿缓存。 */
async function writeSegment(cache: Cache, key: string, buffer: ArrayBuffer, opts: CacheWriteOptions): Promise<void> {
  await cache.put(key, new Response(buffer));
  try {
    await db.segmentMeta.put({
      key, episodeKey: opts.episodeKey, index: opts.index, bytes: buffer.byteLength,
      costMs: Math.max(1, Math.round(opts.costMs)), lastAccess: Date.now(),
    });
  } catch (error) {
    await cache.delete(key);
    throw error;
  }
}

/** 为新分片预留空间；背景预取不得驱逐当前集未播放内容，空间不足即停止扩窗。 */
async function reserveSpace(cache: Cache, key: string, bytes: number, opts: CacheWriteOptions, forceBytes = 0): Promise<boolean> {
  const metas = await db.segmentMeta.toArray();
  const plan = planCacheEviction(metas, opts.settings, playbackWindow, {
    key, bytes, episodeKey: opts.episodeKey, background: opts.background, forceBytes,
  });
  if (!plan.fits) return false;
  await removeSegments(cache, plan.keys);
  return true;
}

/** 写入前预留预算；revision 为下载开始版本，QuotaExceeded 时额外释放实际字节。 */
export function putCachedSegmentResilient(key: string, buffer: ArrayBuffer, opts: CacheWriteOptions): Promise<CachePutResult> {
  const expectedRevision = opts.revision ?? revision;
  return serializeMutation(async () => {
    const store = cacheStore();
    if (!store || expectedRevision !== revision || !loadCacheSettings().enabled) return 'failed';
    try {
      const cache = await store.open(VIDEO_CACHE_NAME);
      if (!(await reserveSpace(cache, key, buffer.byteLength, opts))) return 'quota';
      if (expectedRevision !== revision) return 'failed';
      try {
        await writeSegment(cache, key, buffer, opts);
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== 'QuotaExceededError') throw error;
        if (!(await reserveSpace(cache, key, buffer.byteLength, opts, buffer.byteLength))) return 'quota';
        await writeSegment(cache, key, buffer, opts);
      }
      if (expectedRevision !== revision) {
        await removeSegments(cache, [key]);
        return 'failed';
      }
      return 'ok';
    } catch (error) {
      return error instanceof DOMException && error.name === 'QuotaExceededError' ? 'quota' : 'failed';
    }
  });
}

/** 串行配额收敛；共享播放窗口优先级，不与写入或清理竞争。 */
export function enforceQuota(settings?: CacheSettings): Promise<number> {
  return serializeMutation(async () => {
    const store = cacheStore();
    if (!store) return 0;
    try {
      const cache = await store.open(VIDEO_CACHE_NAME);
      const metas = await db.segmentMeta.toArray();
      const plan = planCacheEviction(metas, settings ?? loadCacheSettings(), playbackWindow);
      await removeSegments(cache, plan.keys);
      return plan.keys.length;
    } catch {
      return 0;
    }
  });
}

/** 命中/读取时刷新 lastAccess；30s 内同 key 只写一次，避免高频写放大 */
const touchTimers = new Map<string, number>();
export async function touchMeta(key: string): Promise<void> {
  const now = Date.now();
  const last = touchTimers.get(key) ?? 0;
  if (now - last < META_FLUSH_DEBOUNCE_MS) return;
  touchTimers.set(key, now);
  try {
    const meta = await db.segmentMeta.get(key);
    if (meta) await db.segmentMeta.update(key, { lastAccess: now });
  } catch { /* 忽略 */ }
}

export interface CacheSummary {
  segments: number;
  bytes: number;
  episodes: number;
}

export async function getCacheSummary(): Promise<CacheSummary> {
  try {
    const metas = await db.segmentMeta.toArray();
    return {
      segments: metas.length,
      bytes: metas.reduce((sum, m) => sum + m.bytes, 0),
      episodes: new Set(metas.map((m) => m.episodeKey)).size,
    };
  } catch {
    return { segments: 0, bytes: 0, episodes: 0 };
  }
}

/** 清理前使下载失效；等待旧写入完成后删除，禁止旧任务重新填充。 */
export function clearVideoCache(): Promise<void> {
  invalidateCache();
  return serializeMutation(async () => {
    const store = cacheStore();
    if (store) await store.delete(VIDEO_CACHE_NAME);
    await db.segmentMeta.clear();
    touchTimers.clear();
  });
}

/** 删除指定集；使旧预取失效后串行删除，避免清理期间重新写入。 */
export function deleteEpisodeCache(episodeKey: string): Promise<void> {
  invalidateCache();
  return serializeMutation(async () => {
    const store = cacheStore();
    const metas = await db.segmentMeta.where('episodeKey').equals(episodeKey).toArray();
    if (store) await removeSegments(await store.open(VIDEO_CACHE_NAME), metas.map((meta) => meta.key));
    else await db.segmentMeta.bulkDelete(metas.map((meta) => meta.key));
  });
}
