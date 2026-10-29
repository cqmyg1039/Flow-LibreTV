import { describe, expect, it } from 'vitest';

import type { SegmentMetaEntry } from './db';
import { planCacheEviction, type PlaybackCacheWindow } from './video-cache-policy';

const SETTINGS = { enabled: true, horizonSeconds: 300, maxBytesPerEpisode: 30, maxTotalBytes: 40 };
const WINDOW: PlaybackCacheWindow = { episodeKey: 'current', currentIndex: 2, protectedKeys: new Set(['near']) };
/** 构造固定大小元数据；index 用于区分已播和未来分片。 */
function meta(key: string, episodeKey = 'current', index = 1, lastAccess = 1): SegmentMetaEntry {
  return { key, episodeKey, index, lastAccess, bytes: 10, costMs: 100 };
}

describe('cache eviction policy', () => {
  it('reserves incoming bytes and protects the playback window', () => {
    const result = planCacheEviction([meta('past'), meta('near', 'current', 2), meta('future', 'current', 8)], SETTINGS, WINDOW,
      { key: 'new', bytes: 10, episodeKey: 'current', background: true });
    expect(result).toEqual({ keys: ['past'], fits: true });
  });
  it('stops background caching instead of deleting unplayed fragments', () => {
    const result = planCacheEviction([meta('near', 'current', 2), meta('future', 'current', 8)],
      { ...SETTINGS, maxBytesPerEpisode: 20 }, WINDOW, { key: 'new', bytes: 10, episodeKey: 'current', background: true });
    expect(result.fits).toBe(false);
    expect(result.keys).toEqual([]);
  });
  it('evicts other episodes before current future data on global pressure', () => {
    const result = planCacheEviction([meta('near', 'current', 2), meta('future', 'current', 8), meta('old', 'other', 1, 99)],
      { ...SETTINGS, maxTotalBytes: 30 }, WINDOW, { key: 'new', bytes: 10, episodeKey: 'next', background: true });
    expect(result).toEqual({ keys: ['old'], fits: true });
  });
  it('forces actual byte release on browser quota errors even below configured limits', () => {
    const result = planCacheEviction([meta('old', 'other')], SETTINGS, WINDOW,
      { key: 'new', bytes: 10, episodeKey: 'current', forceBytes: 10 });
    expect(result).toEqual({ keys: ['old'], fits: true });
  });
  it('stops next-episode prefetch instead of evicting its own earlier downloads', () => {
    const result = planCacheEviction([meta('next-1', 'next', 1), meta('next-2', 'next', 2)],
      { ...SETTINGS, maxBytesPerEpisode: 20 }, WINDOW,
      { key: 'next-3', bytes: 10, episodeKey: 'next', background: true });
    expect(result).toEqual({ keys: [], fits: false });
  });
  it('does not double-count a replacement', () => {
    expect(planCacheEviction([meta('near')], SETTINGS, WINDOW, { key: 'near', bytes: 20, episodeKey: 'current' })).toEqual({ keys: [], fits: true });
  });
});
