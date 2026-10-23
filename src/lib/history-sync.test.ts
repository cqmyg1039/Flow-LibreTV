import { describe, expect, it } from 'vitest';
import { mergeHistoryEntries, mergeProgressEntries } from './history-sync';
import type { HistoryEntry, ProgressEntry } from './db';

function history(id: string, timestamp: number): HistoryEntry {
  return {
    id,
    sourceKey: 'src',
    vodId: id,
    title: `标题-${id}`,
    episodeIndex: 0,
    totalEpisodes: 0,
    playbackPosition: 0,
    duration: 0,
    timestamp,
  };
}

function progress(key: string, updatedAt: number): ProgressEntry {
  return { key, position: 10, duration: 100, updatedAt };
}

describe('mergeHistoryEntries', () => {
  it('本地为空时采纳全部远端记录', () => {
    const remote = [history('a', 1), history('b', 2)];
    const merged = mergeHistoryEntries([], remote, new Set());
    expect(merged.map((e) => e.id).sort()).toEqual(['a', 'b']);
  });

  it('远端更新（timestamp 更大）时覆盖本地', () => {
    const local = [history('a', 100)];
    const remote = [history('a', 200)];
    const merged = mergeHistoryEntries(local, remote, new Set());
    expect(merged).toHaveLength(1);
    expect(merged[0].timestamp).toBe(200);
  });

  it('远端更旧时保留本地', () => {
    const local = [history('a', 200)];
    const remote = [history('a', 100)];
    const merged = mergeHistoryEntries(local, remote, new Set());
    expect(merged[0].timestamp).toBe(200);
  });

  it('timestamp 相同时保留本地（不回滚）', () => {
    const local = [history('a', 100)];
    const remote = [history('a', 100)];
    const merged = mergeHistoryEntries(local, remote, new Set());
    expect(merged[0].timestamp).toBe(100);
  });

  it('本地 pending 中的条目以本地为准（不被远端覆盖）', () => {
    const local = [history('a', 300)];
    const remote = [history('a', 999)];
    const merged = mergeHistoryEntries(local, remote, new Set(['a']));
    expect(merged[0].timestamp).toBe(300);
  });

  it('远端新增的条目被加入，本地已有条目保留', () => {
    const local = [history('a', 100)];
    const remote = [history('a', 90), history('b', 50)];
    const merged = mergeHistoryEntries(local, remote, new Set());
    expect(merged).toHaveLength(2);
    expect(merged.find((e) => e.id === 'a')?.timestamp).toBe(100);
    expect(merged.find((e) => e.id === 'b')?.timestamp).toBe(50);
  });
});

describe('mergeProgressEntries', () => {
  it('本地为空时采纳全部远端记录', () => {
    const merged = mergeProgressEntries([], [progress('k1', 1)], new Set());
    expect(merged).toHaveLength(1);
    expect(merged[0].key).toBe('k1');
  });

  it('远端 updatedAt 更新时覆盖本地', () => {
    const local = [progress('k1', 100)];
    const remote = [progress('k1', 200)];
    const merged = mergeProgressEntries(local, remote, new Set());
    expect(merged[0].updatedAt).toBe(200);
  });

  it('远端更旧时保留本地', () => {
    const local = [progress('k1', 200)];
    const remote = [progress('k1', 100)];
    const merged = mergeProgressEntries(local, remote, new Set());
    expect(merged[0].updatedAt).toBe(200);
  });

  it('本地 pending 中的 key 以本地为准', () => {
    const local = [progress('k1', 300)];
    const remote = [progress('k1', 999)];
    const merged = mergeProgressEntries(local, remote, new Set(['k1']));
    expect(merged[0].updatedAt).toBe(300);
  });

  it('不同 key 互不影响', () => {
    const local = [progress('k1', 100)];
    const remote = [progress('k2', 50)];
    const merged = mergeProgressEntries(local, remote, new Set());
    expect(merged).toHaveLength(2);
    expect(merged.find((e) => e.key === 'k1')?.updatedAt).toBe(100);
    expect(merged.find((e) => e.key === 'k2')?.updatedAt).toBe(50);
  });
});
