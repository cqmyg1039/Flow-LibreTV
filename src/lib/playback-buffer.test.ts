import type Artplayer from 'artplayer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { bindPlaybackPrefetch, bufferedAhead, buildPlaybackHlsConfig } from './playback-buffer';

const prefetch = vi.hoisted(() => ({
  current: { setThrottled: vi.fn() },
  next: { setThrottled: vi.fn() },
}));
vi.mock('./video-prefetcher', () => ({
  getVideoPrefetcher: () => prefetch.current,
  getNextEpisodePrefetcher: () => prefetch.next,
}));
afterEach(() => vi.clearAllMocks());

function ranges(values: [number, number][]): TimeRanges {
  return {
    length: values.length,
    start: (index) => values[index][0],
    end: (index) => values[index][1],
  };
}

function player() {
  const video = Object.assign(new EventTarget(), {
    currentTime: 10,
    buffered: ranges([[0, 15], [50, 100]]),
    paused: false,
    seeking: false,
    readyState: 3,
  });
  return { video };
}

describe('playback buffer priorities', () => {
  it('does not count disjoint ranges as playable buffer', () => {
    expect(bufferedAhead(ranges([[0, 15], [50, 100]]), 10)).toBe(5);
    expect(bufferedAhead(ranges([[50, 100]]), 10)).toBe(0);
  });

  it('increases normal forward buffer and limits the retained back buffer', () => {
    const config = buildPlaybackHlsConfig(false, false);
    expect(config.maxBufferLength).toBe(60);
    expect(config.backBufferLength).toBe(30);
  });

  it('throttles both prefetchers while waiting and only resumes with enough buffer', () => {
    const art = player();
    const cleanup = bindPlaybackPrefetch(art as unknown as Artplayer, vi.fn());
    art.video.dispatchEvent(new Event('playing'));
    expect(prefetch.current.setThrottled).toHaveBeenLastCalledWith(true);
    expect(prefetch.next.setThrottled).toHaveBeenLastCalledWith(true);
    art.video.buffered = ranges([[0, 40]]);
    art.video.dispatchEvent(new Event('progress'));
    expect(prefetch.current.setThrottled).toHaveBeenLastCalledWith(false);
    expect(prefetch.next.setThrottled).toHaveBeenLastCalledWith(true);
    art.video.buffered = ranges([[0, 80]]);
    art.video.dispatchEvent(new Event('progress'));
    expect(prefetch.next.setThrottled).toHaveBeenLastCalledWith(false);
    art.video.dispatchEvent(new Event('waiting'));
    expect(prefetch.current.setThrottled).toHaveBeenLastCalledWith(true);
    expect(prefetch.next.setThrottled).toHaveBeenLastCalledWith(true);
    cleanup();
    vi.clearAllMocks();
    art.video.dispatchEvent(new Event('progress'));
    expect(prefetch.current.setThrottled).not.toHaveBeenCalled();
  });

  it('allows caching on a user pause but not a seek-induced pause', () => {
    const art = player();
    const onPause = vi.fn();
    const cleanup = bindPlaybackPrefetch(art as unknown as Artplayer, onPause);
    art.video.paused = true;
    art.video.dispatchEvent(new Event('pause'));
    expect(prefetch.current.setThrottled).toHaveBeenLastCalledWith(false);
    expect(onPause).toHaveBeenCalledOnce();
    art.video.seeking = true;
    art.video.dispatchEvent(new Event('pause'));
    expect(prefetch.current.setThrottled).toHaveBeenLastCalledWith(true);
    expect(onPause).toHaveBeenCalledOnce();
    cleanup();
  });
});
