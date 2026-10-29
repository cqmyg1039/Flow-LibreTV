import type Hls from 'hls.js';
import { describe, expect, it, vi } from 'vitest';

import { getPlaybackPlaylist, getPlaybackSegmentIndex, protectPlaybackCache } from './playback-cache';
import { setPlaybackCacheWindow } from './video-cache';

vi.mock('./video-cache', () => ({
  buildSegmentCacheKey: (url: string) => url,
  setPlaybackCacheWindow: vi.fn(),
}));

/** 多档位假播放器；分片序号偏移，保证缓存序号来自数组位置。 */
function player(currentLevel = 0): Hls {
  return { currentLevel, loadLevel: 1, levels: [
    { details: { url: '720.m3u8', fragments: Array.from({ length: 30 }, (_, index) => ({
      sn: 100 + index, start: index * 5, duration: 5, url: `720-${index}.ts`,
    })) } },
    { details: { url: '1080.m3u8', fragments: [{ sn: 200, start: 0, duration: 5, url: '1080-0.ts' }] } },
  ] } as unknown as Hls;
}

describe('actual playback cache context', () => {
  it('follows actual selected media playlist instead of the master maximum', () => {
    expect(getPlaybackPlaylist(player())).toBe('720.m3u8');
    expect(getPlaybackPlaylist(player(1))).toBe('1080.m3u8');
    expect(getPlaybackPlaylist(player(-1))).toBe('1080.m3u8');
    expect(getPlaybackPlaylist(null)).toBeUndefined();
  });
  it('uses segment array positions instead of media sequence numbers', () => {
    expect(getPlaybackSegmentIndex(player(), '720-5.ts')).toBe(6);
    expect(getPlaybackSegmentIndex(player(), 'init.mp4')).toBe(0);
  });
  it('protects the current thirty-second rewind and sixty-second forward window', () => {
    protectPlaybackCache(player(), 'episode', 50);
    expect(setPlaybackCacheWindow).toHaveBeenLastCalledWith(expect.objectContaining({
      episodeKey: 'episode', currentIndex: 11,
      protectedKeys: expect.any(Set),
    }));
    const window = vi.mocked(setPlaybackCacheWindow).mock.calls.at(-1)![0]!;
    expect(window.protectedKeys.has('720-10.ts')).toBe(true);
    expect(window.protectedKeys.has('720-0.ts')).toBe(false);
    expect(window.protectedKeys.has('720-25.ts')).toBe(false);
  });
});
