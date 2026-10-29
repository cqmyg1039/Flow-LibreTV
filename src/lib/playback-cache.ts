import type Hls from 'hls.js';

import { buildSegmentCacheKey, setPlaybackCacheWindow } from './video-cache';

/** 获取已实际选择的媒体清单，禁止让预取从 master 默认选择最高档位。 */
export function getPlaybackPlaylist(hls: Hls | null): string | undefined {
  if (!hls) return undefined;
  const level = hls.levels[hls.currentLevel >= 0 ? hls.currentLevel : hls.loadLevel];
  return level?.details?.url;
}

/** 从播放器真实分片列表更新保护窗口；入参为实例、剧集和播放头秒数。 */
export function protectPlaybackCache(hls: Hls | null, episodeKey: string, currentTime: number): void {
  if (!hls) return;
  const level = hls.levels[hls.currentLevel >= 0 ? hls.currentLevel : hls.loadLevel];
  const fragments = level?.details?.fragments ?? [];
  if (!fragments.length) return;
  const current = fragments.findIndex((frag) => frag.start + frag.duration > currentTime);
  setPlaybackCacheWindow({
    episodeKey, currentIndex: (current < 0 ? fragments.length - 1 : current) + 1,
    protectedKeys: new Set(fragments.filter((frag) => frag.start + frag.duration >= currentTime - 30 &&
      frag.start <= currentTime + 60).map((frag) => buildSegmentCacheKey(frag.url))),
  });
}

/** 按分片地址获取真实序号；媒体序号不必从零开始，不能直接拿 sn 当数组下标。 */
export function getPlaybackSegmentIndex(hls: Hls | null, url: string): number {
  const key = buildSegmentCacheKey(url);
  for (const level of hls?.levels ?? []) {
    const index = level.details?.fragments.findIndex((frag) => buildSegmentCacheKey(frag.url) === key) ?? -1;
    if (index >= 0) return index + 1;
  }
  return 0; // 初始化分片等不在常规 fragments 中的资源。
}
