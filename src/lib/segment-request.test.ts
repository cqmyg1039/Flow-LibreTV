import { describe, expect, it, vi } from 'vitest';

import { shareSegmentRequest } from './segment-request';

/** 创建可手动完成的下载，用于验证消费者取消与网络取消的边界。 */
function deferred() {
  let resolve!: (value: { data: ArrayBuffer; costMs: number }) => void;
  const promise = new Promise<{ data: ArrayBuffer; costMs: number }>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('shared segment requests', () => {
  it('coalesces player and prefetch and keeps network alive when only prefetch cancels', async () => {
    const pending = deferred();
    let networkSignal!: AbortSignal;
    const producer = vi.fn((signal: AbortSignal) => { networkSignal = signal; return pending.promise; });
    const prefetch = new AbortController();
    const player = new AbortController();
    const first = shareSegmentRequest('shared', prefetch.signal, producer);
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const second = shareSegmentRequest('shared', player.signal, producer);
    await Promise.resolve();
    prefetch.abort();
    await rejected;
    expect(networkSignal.aborted).toBe(false);
    pending.resolve({ data: new ArrayBuffer(8), costMs: 100 });
    expect((await second).data.byteLength).toBe(8);
    expect(producer).toHaveBeenCalledOnce();
  });

  it('aborts transport after the last consumer leaves and permits a fresh retry', async () => {
    const pending = deferred();
    let networkSignal!: AbortSignal;
    const controller = new AbortController();
    const first = shareSegmentRequest('cancel-all', controller.signal, (signal) => { networkSignal = signal; return pending.promise; });
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    controller.abort();
    await rejected;
    expect(networkSignal.aborted).toBe(true);
    const retry = vi.fn().mockResolvedValue({ data: new ArrayBuffer(4), costMs: 20 });
    expect((await shareSegmentRequest('cancel-all', new AbortController().signal, retry)).data.byteLength).toBe(4);
    pending.resolve({ data: new ArrayBuffer(8), costMs: 100 });
  });

  it('provides separate ArrayBuffers so playback transfer cannot detach the prefetch copy', async () => {
    const producer = async () => ({ data: new ArrayBuffer(8), costMs: 1 });
    const [player, prefetch] = await Promise.all([
      shareSegmentRequest('transfer', new AbortController().signal, producer),
      shareSegmentRequest('transfer', new AbortController().signal, producer),
    ]);
    structuredClone(player.data, { transfer: [player.data] });
    expect(player.data.byteLength).toBe(0);
    expect(prefetch.data.byteLength).toBe(8);
  });

  it('removes failed requests so later attempts can retry', async () => {
    await expect(shareSegmentRequest('failure', new AbortController().signal, () => Promise.reject(new Error('offline')))).rejects.toThrow('offline');
    const result = await shareSegmentRequest('failure', new AbortController().signal, async () => ({ data: new ArrayBuffer(1), costMs: 1 }));
    expect(result.data.byteLength).toBe(1);
  });
});
