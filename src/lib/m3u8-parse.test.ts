import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseM3u8Playlist } from './m3u8-parse';

const FILTER = vi.hoisted(() => vi.fn((text: string) => text));
vi.mock('./m3u8', async (original) => ({
  ...await original<typeof import('./m3u8')>(),
  stripAdGroups: FILTER,
}));

const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720\n720.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080\n1080.m3u8';
const MEDIA = '#EXTM3U\n#EXTINF:5,\nsegment.ts\n#EXT-X-ENDLIST';

beforeEach(() => {
  FILTER.mockClear();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(url.endsWith('master.m3u8') ? MASTER : MEDIA)));
});
afterEach(() => vi.unstubAllGlobals());

describe('prefetch playlist configuration', () => {
  it('selects the requested next-episode height rather than the maximum bandwidth', async () => {
    const parsed = await parseM3u8Playlist('https://cdn.test/master.m3u8', 0, 720);
    expect(fetch).toHaveBeenCalledWith('https://cdn.test/720.m3u8', expect.any(Object));
    expect(parsed.segments[0].url).toBe('https://cdn.test/segment.ts');
  });
  it('honors disabled ad filtering through nested master playlists', async () => {
    await parseM3u8Playlist('https://cdn.test/master.m3u8', 0, 720, { stripLeadAd: false });
    expect(FILTER).not.toHaveBeenCalled();
    await parseM3u8Playlist('https://cdn.test/master.m3u8', 0, 720, { stripLeadAd: true });
    expect(FILTER).toHaveBeenCalledTimes(2);
  });
  it('forwards cancellation to every nested playlist request', async () => {
    const controller = new AbortController();
    await parseM3u8Playlist('https://cdn.test/master.m3u8', 0, 720, { signal: controller.signal });
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call[1]?.signal === controller.signal)).toBe(true);
  });
});
