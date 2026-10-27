import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HistoryEntry } from './db';

const local = vi.hoisted(() => ({ history: { toArray: vi.fn(), bulkPut: vi.fn() }, progress: { toArray: vi.fn(), bulkPut: vi.fn() } }));
vi.mock('./db', () => ({ db: local }));
const entry = (timestamp: number): HistoryEntry => ({ id: 's_1', sourceKey: 's', vodId: '1', title: 'Test', episodeIndex: 0, totalEpisodes: 1, playbackPosition: timestamp, duration: 100, timestamp });
let storage: Map<string, string>;
const success = () => new Response(JSON.stringify({ history: [], progress: [] }), { status: 200 });

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  storage = new Map();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  local.history.toArray.mockResolvedValue([]);
  local.progress.toArray.mockResolvedValue([]);
  local.history.bulkPut.mockResolvedValue(undefined);
  local.progress.bulkPut.mockResolvedValue(undefined);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('durable history sync', () => {
  it('retains writes made while a request is in flight', async () => {
    let complete!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { complete = resolve; })).mockImplementation(async () => success());
    vi.stubGlobal('fetch', fetcher);
    const sync = await import('./history-sync');
    sync.enqueueHistoryEntry(entry(1));
    const first = sync.flushHistorySync();
    sync.enqueueHistoryEntry(entry(2));
    complete(success());
    await first;
    await sync.flushHistorySync();
    expect(JSON.parse(fetcher.mock.calls[1][1].body).history[0].timestamp).toBe(2);
  });

  it('restores pending writes after module/session restart', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => success());
    vi.stubGlobal('fetch', fetcher);
    const sync = await import('./history-sync');
    sync.enqueueHistoryEntry(entry(7));
    vi.resetModules();
    const restored = await import('./history-sync');
    await restored.flushHistorySync();
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string).history[0].timestamp).toBe(7);
  });

  it('backfills local-only records after a successful pull', async () => {
    local.history.toArray.mockResolvedValue([entry(8)]);
    const fetcher = vi.fn<typeof fetch>(async () => success());
    vi.stubGlobal('fetch', fetcher);
    const sync = await import('./history-sync');
    await sync.resumeHistorySync();
    expect(fetcher.mock.calls).toHaveLength(2);
    expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string).history[0].timestamp).toBe(8);
  });

  it('does not resurrect a pending deletion on pull', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ history: [entry(9)], progress: [] }))));
    const sync = await import('./history-sync');
    sync.enqueueHistoryDelete('s_1');
    await sync.syncPull();
    expect(local.history.bulkPut).not.toHaveBeenCalled();
  });

  it('keeps operations when the database is disabled and resumes when configured', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ syncEnabled: false }), { status: 503 })).mockImplementation(async () => success());
    vi.stubGlobal('fetch', fetcher);
    const sync = await import('./history-sync');
    await sync.syncPull();
    sync.enqueueHistoryEntry(entry(10));
    expect([...storage.values()].join('')).toContain('s_1');
    await sync.resumeHistorySync();
    expect(fetcher.mock.calls).toHaveLength(3);
  });

  it('retries network failures without another playback write', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(async () => success());
    vi.stubGlobal('fetch', fetcher);
    const sync = await import('./history-sync');
    sync.enqueueHistoryEntry(entry(11));
    await sync.flushHistorySync();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not disable sync for an authentication setup 503', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: 'setup' }), { status: 503 })).mockImplementation(async () => success());
    vi.stubGlobal('fetch', fetcher);
    const sync = await import('./history-sync');
    await sync.syncPull();
    sync.enqueueHistoryEntry(entry(12));
    await sync.flushHistorySync();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('schedules newer writes when the debounce fires during an active request', async () => {
    let complete!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { complete = resolve; })).mockImplementation(async () => success());
    vi.stubGlobal('fetch', fetcher);
    const sync = await import('./history-sync');
    sync.enqueueHistoryEntry(entry(1));
    const first = sync.flushHistorySync();
    sync.enqueueHistoryEntry(entry(2));
    await vi.advanceTimersByTimeAsync(2000);
    complete(success());
    await first;
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetcher.mock.calls[1][1].body).history[0].timestamp).toBe(2);
  });

  it('does not repeat a successful clear after a progress upload fails', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(success()).mockRejectedValueOnce(new Error('offline')).mockImplementation(async () => success());
    vi.stubGlobal('fetch', fetcher);
    const sync = await import('./history-sync');
    sync.enqueueHistoryClear();
    sync.enqueueHistoryEntry(entry(20));
    sync.enqueueProgressEntry({ key: 's_1_0', position: 20, duration: 100, updatedAt: 20 });
    await sync.flushHistorySync();
    await sync.flushHistorySync();
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual(['/api/history', '/api/progress', '/api/progress']);
  });

  it('retains progress until a pending clear succeeds', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(async () => success());
    vi.stubGlobal('fetch', fetcher);
    const sync = await import('./history-sync');
    sync.enqueueHistoryClear();
    sync.enqueueProgressEntry({ key: 's_1_0', position: 20, duration: 100, updatedAt: 20 });
    await sync.flushHistorySync();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await sync.flushHistorySync();
    expect(JSON.parse(fetcher.mock.calls[2][1].body).progress).toHaveLength(1);
  });

});
