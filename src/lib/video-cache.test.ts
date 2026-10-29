import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SegmentMetaEntry } from './db';
import {
  clearVideoCache, DEFAULT_CACHE_SETTINGS, getCacheRevision, onCacheInvalidated,
  putCachedSegmentResilient, saveCacheSettings, setPlaybackCacheWindow, VIDEO_CACHE_NAME,
} from './video-cache';

const STATE = vi.hoisted(() => ({ metas: new Map<string, SegmentMetaEntry>() }));
vi.mock('./db', () => ({ db: { segmentMeta: {
  toArray: async () => [...STATE.metas.values()],
  put: vi.fn(async (meta: SegmentMetaEntry) => { STATE.metas.set(meta.key, meta); }),
  delete: async (key: string) => { STATE.metas.delete(key); },
  clear: async () => { STATE.metas.clear(); },
} } }));

let entries: Map<string, Response>;
let cache: { put: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
/** 使用内存缓存与元数据模拟存储，不依赖 Node 环境不存在的 IndexedDB。 */
beforeEach(() => {
  STATE.metas.clear();
  entries = new Map();
  cache = {
    put: vi.fn(async (key: string, response: Response) => { entries.set(key, response); }),
    delete: vi.fn(async (key: string) => entries.delete(key)),
  };
  const settings = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => settings.get(key), setItem: (key: string, value: string) => settings.set(key, value) });
  vi.stubGlobal('caches', { open: vi.fn(async () => cache), delete: vi.fn(async () => { entries.clear(); return true; }) });
  setPlaybackCacheWindow();
});
afterEach(() => vi.unstubAllGlobals());

/** 默认写入参数；每个请求显式记录开始时版本。 */
function options() {
  return { episodeKey: 'episode', index: 1, costMs: 100, settings: DEFAULT_CACHE_SETTINGS, revision: getCacheRevision() };
}

describe('cache write lifecycle', () => {
  it('rejects late writes after clear without repopulating storage', async () => {
    const opts = options();
    await clearVideoCache();
    expect(await putCachedSegmentResilient('late', new ArrayBuffer(8), opts)).toBe('failed');
    expect(cache.put).not.toHaveBeenCalled();
    expect(caches.delete).toHaveBeenCalledWith(VIDEO_CACHE_NAME);
  });
  it('notifies stop listeners immediately on disable and rejects old writes', async () => {
    const listener = vi.fn();
    const unsubscribe = onCacheInvalidated(listener);
    const opts = options();
    saveCacheSettings({ enabled: false });
    expect(listener).toHaveBeenCalledOnce();
    expect(await putCachedSegmentResilient('late', new ArrayBuffer(8), opts)).toBe('failed');
    unsubscribe();
  });
  it('serializes cleanup behind an active write', async () => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    cache.put.mockImplementationOnce(async (key: string, response: Response) => { started(); await gate; entries.set(key, response); });
    const writing = putCachedSegmentResilient('active', new ArrayBuffer(8), options());
    await entered;
    const clearing = clearVideoCache();
    release();
    await Promise.all([writing, clearing]);
    expect(entries.size).toBe(0);
    expect(STATE.metas.size).toBe(0);
  });
  it('rolls back a write already inside cache.put when the user disables caching', async () => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    cache.put.mockImplementationOnce(async (key: string, response: Response) => { started(); await gate; entries.set(key, response); });
    const writing = putCachedSegmentResilient('active', new ArrayBuffer(8), options());
    await entered;
    saveCacheSettings({ enabled: false });
    release();
    expect(await writing).toBe('failed');
    expect(entries.size).toBe(0);
    expect(STATE.metas.size).toBe(0);
  });
  it('releases space on browser quota failure even when under application limits', async () => {
    STATE.metas.set('old', { key: 'old', episodeKey: 'other', index: 1, bytes: 8, costMs: 1, lastAccess: 1 });
    entries.set('old', new Response(new ArrayBuffer(8)));
    cache.put.mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'));
    expect(await putCachedSegmentResilient('new', new ArrayBuffer(8), options())).toBe('ok');
    expect(entries.has('old')).toBe(false);
    expect(entries.has('new')).toBe(true);
    expect(cache.put).toHaveBeenCalledTimes(2);
  });
});
