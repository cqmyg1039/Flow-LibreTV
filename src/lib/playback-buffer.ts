import type Artplayer from 'artplayer';
import Hls, { type HlsConfig } from 'hls.js';

import { createHlsLoader, type LoaderOptions } from './hls-loader';
import { getNextEpisodePrefetcher, getVideoPrefetcher } from './video-prefetcher';

const PREFETCH_BUFFER_SECONDS = 20;
const NEXT_EPISODE_BUFFER_SECONDS = 60;

/** Return contiguous playable seconds at position; disjoint future ranges do not count. */
export function bufferedAhead(buffered: TimeRanges, position: number): number {
  for (let index = 0; index < buffered.length; index += 1) {
    if (buffered.start(index) <= position && buffered.end(index) > position) {
      return buffered.end(index) - position;
    }
  }
  return 0;
}

/** Build VOD buffering options. Parameters control ad filtering and disk-cache capacity. */
export function buildPlaybackHlsConfig(adFilter: boolean, cacheEnabled: boolean, getCacheContext?: LoaderOptions['getCacheContext']): Partial<HlsConfig> {
  return {
    debug: false,
    enableWorker: true,
    backBufferLength: 30,
    maxBufferLength: cacheEnabled ? 120 : 60,
    maxMaxBufferLength: cacheEnabled ? 180 : 120,
    maxBufferSize: (cacheEnabled ? 90 : 60) * 1000 * 1000,
    maxBufferHole: 0.5,
    fragLoadingMaxRetry: 6,
    fragLoadingRetryDelay: 1000,
    manifestLoadingMaxRetry: 3,
    manifestLoadingRetryDelay: 1000,
    startLevel: -1,
    abrEwmaDefaultEstimate: 500_000,
    appendErrorMaxRetry: 5,
    loader: createHlsLoader(Hls, { blockAd: adFilter, getCacheContext }) as unknown as HlsConfig['loader'],
  };
}

/** Apply bandwidth priorities from video state; onPause saves progress and extends cache. */
export function bindPlaybackPrefetch(art: Artplayer, onPause: () => void): () => void {
  const current = getVideoPrefetcher();
  const next = getNextEpisodePrefetcher();
  const update = () => {
    const video = art.video;
    const ahead = bufferedAhead(video.buffered, video.currentTime);
    const paused = video.paused && !video.seeking && video.readyState >= 2;
    current.setThrottled(!paused && ahead < PREFETCH_BUFFER_SECONDS);
    next.setThrottled(!paused && ahead < NEXT_EPISODE_BUFFER_SECONDS);
  };
  const waiting = () => {
    current.setThrottled(true);
    next.setThrottled(true);
  };
  const pause = () => {
    update();
    if (art.video.readyState >= 2 && !art.video.seeking) onPause();
  };
  const events = ['timeupdate', 'playing', 'progress', 'seeked'];
  events.forEach((event) => art.video.addEventListener(event, update));
  art.video.addEventListener('waiting', waiting);
  art.video.addEventListener('seeking', waiting);
  art.video.addEventListener('pause', pause);
  waiting();
  return () => {
    events.forEach((event) => art.video.removeEventListener(event, update));
    art.video.removeEventListener('waiting', waiting);
    art.video.removeEventListener('seeking', waiting);
    art.video.removeEventListener('pause', pause);
  };
}
