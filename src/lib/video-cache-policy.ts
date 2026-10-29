import type { SegmentMetaEntry } from './db';
import type { CacheSettings } from './video-cache';

export interface PlaybackCacheWindow {
  episodeKey: string;
  currentIndex: number;
  protectedKeys: Set<string>;
}

interface Reservation {
  key: string;
  bytes: number;
  episodeKey: string;
  background?: boolean;
  forceBytes?: number;
}

/** 计算淘汰顺序：其他集 → 已播放 → 远端未来；播放头附近始终保护。 */
function evictionRank(meta: SegmentMetaEntry, window?: PlaybackCacheWindow): number {
  if (!window || meta.episodeKey !== window.episodeKey) return 0;
  return meta.index < window.currentIndex ? 1 : 2;
}

/** 规划配额预留；入参为元数据、预算、播放窗口和新分片，不执行 I/O。 */
export function planCacheEviction(
  metas: SegmentMetaEntry[], settings: CacheSettings,
  window?: PlaybackCacheWindow, incoming?: Reservation,
): { keys: string[]; fits: boolean } {
  const existing = metas.filter((meta) => meta.key !== incoming?.key);
  const episodeBytes = new Map<string, number>();
  for (const meta of existing) episodeBytes.set(meta.episodeKey, (episodeBytes.get(meta.episodeKey) ?? 0) + meta.bytes);
  if (incoming) episodeBytes.set(incoming.episodeKey, (episodeBytes.get(incoming.episodeKey) ?? 0) + incoming.bytes);
  let total = existing.reduce((sum, meta) => sum + meta.bytes, incoming?.bytes ?? 0);
  let forced = incoming?.forceBytes ?? 0;
  const keys: string[] = [];
  const candidates = existing.filter((meta) => {
    if (window?.protectedKeys.has(meta.key)) return false;
    if (!incoming?.background) return true;
    if (meta.episodeKey === window?.episodeKey && meta.index >= window.currentIndex) return false;
    return meta.episodeKey !== incoming.episodeKey ||
      (meta.episodeKey === window?.episodeKey && meta.index < window.currentIndex);
  }).sort((a, b) => evictionRank(a, window) - evictionRank(b, window) ||
    (evictionRank(a, window) === 2 ? b.index - a.index : a.lastAccess - b.lastAccess));
  for (const meta of candidates) {
    const bytes = episodeBytes.get(meta.episodeKey) ?? 0;
    if (bytes <= settings.maxBytesPerEpisode && total <= settings.maxTotalBytes && forced <= 0) continue;
    keys.push(meta.key);
    episodeBytes.set(meta.episodeKey, bytes - meta.bytes);
    total -= meta.bytes;
    forced -= meta.bytes;
  }
  return { keys, fits: total <= settings.maxTotalBytes && forced <= 0 &&
    [...episodeBytes.values()].every((bytes) => bytes <= settings.maxBytesPerEpisode) };
}
