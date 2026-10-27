/**
 * 观看历史 / 播放进度 跨设备同步层（客户端）。
 *
 * 职责：
 * - 本地 IndexedDB 仍是主存储（即时响应、离线可用），本模块只负责
 *   把本地变更推送到云端（Vercel Postgres），并把云端变更拉回合并。
 * - 云端不可用（未配置数据库 / 断网 / 401）时静默降级，不阻塞本地使用；
 *   待推送条目保留在 pending 中，下次写入或启动时自动重试。
 *
 * 合并规则（可单测的纯函数）：
 * - watch_history：按 id 比较 timestamp，新者胜；
 * - watch_progress：按 key 比较 updatedAt，新者胜；
 * - 本地 pending（已写入本地、尚未推送成功）的条目以本地为准，
 *   避免 pull 覆盖掉刚写入还未推送的数据。
 *
 * 依赖方向：本模块运行时依赖 db.ts（IndexedDB）；
 * db.ts 通过动态 import 本模块触发同步，无运行时循环。
 */

import { db, type HistoryEntry, type ProgressEntry } from './db';

/** 云端未配置数据库（503）时标记为禁用：本会话不再发起同步，避免刷请求 */
let disabled = false;
let flushing: Promise<void> | null = null;
let clearRevision = 0;
let mutationRevision = 0;
const QUEUE_STORAGE_KEY = 'libretv-history-sync-pending-v1';
const RETRY_DELAY_MS = 30_000;

/** 待推送队列（Map 按主键合并，同一记录只保留最新值） */
const pendingHistory = new Map<string, HistoryEntry>();
const pendingProgress = new Map<string, ProgressEntry>();
const pendingDeleteHistory = new Set<string>();
const pendingDeleteProgress = new Set<string>();
let pendingClearAll = false;

/** pull 的默认超时：拖太久会延迟播放器恢复，控制在 1.5s 内 */
const PULL_TIMEOUT_MS = 1500;
const FLUSH_DEBOUNCE_MS = 2000;
const FLUSH_MAX_WAIT_MS = 10_000;

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;

// —— 纯合并函数（供单测与 pull 使用） ——

/** Persist pending operations without blocking local playback on storage failures. */
function persistQueue(): void {
  try {
    localStorage.setItem(
      QUEUE_STORAGE_KEY,
      JSON.stringify({
        history: [...pendingHistory.values()],
        progress: [...pendingProgress.values()],
        deleteHistory: [...pendingDeleteHistory],
        deleteProgress: [...pendingDeleteProgress],
        clearAll: pendingClearAll,
      })
    );
  } catch {
    // Keep the in-memory queue when storage is unavailable.
  }
}

/** Restore operations left by the previous session from this origin's storage. */
function restoreQueue(): void {
  try {
    const raw = localStorage.getItem(QUEUE_STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    for (const entry of data.history ?? []) pendingHistory.set(entry.id, entry);
    for (const entry of data.progress ?? []) pendingProgress.set(entry.key, entry);
    for (const id of data.deleteHistory ?? []) pendingDeleteHistory.add(id);
    for (const key of data.deleteProgress ?? []) pendingDeleteProgress.add(key);
    pendingClearAll = data.clearAll === true;
  } catch {
    // Corrupt storage must not prevent access to local history.
  }
}

restoreQueue();

/**
 * 合并历史记录：id → 条目；remote 仅在「本地不存在」或「remote.timestamp 更新」时覆盖；
 * 本地 pending 中的 id 一律以本地为准。
 */
export function mergeHistoryEntries(
  local: HistoryEntry[],
  remote: HistoryEntry[],
  pendingIds: ReadonlySet<string>
): HistoryEntry[] {
  const map = new Map<string, HistoryEntry>();
  for (const entry of local) map.set(entry.id, entry);
  for (const entry of remote) {
    if (pendingIds.has(entry.id)) continue;
    const cur = map.get(entry.id);
    if (!cur || entry.timestamp > cur.timestamp) map.set(entry.id, entry);
  }
  return [...map.values()];
}

/** 合并播放进度：key → 条目；remote 仅在 updatedAt 更新时覆盖；pending 中的 key 以本地为准。 */
export function mergeProgressEntries(
  local: ProgressEntry[],
  remote: ProgressEntry[],
  pendingKeys: ReadonlySet<string>
): ProgressEntry[] {
  const map = new Map<string, ProgressEntry>();
  for (const entry of local) map.set(entry.key, entry);
  for (const entry of remote) {
    if (pendingKeys.has(entry.key)) continue;
    const cur = map.get(entry.key);
    if (!cur || entry.updatedAt > cur.updatedAt) map.set(entry.key, entry);
  }
  return [...map.values()];
}

// —— 调度：防抖 + 最大等待 ——

function clearTimers(): void {
  if (flushTimer) clearTimeout(flushTimer);
  if (maxWaitTimer) clearTimeout(maxWaitTimer);
  flushTimer = null;
  maxWaitTimer = null;
}

function scheduleFlush(): void {
  mutationRevision += 1;
  persistQueue();
  if (disabled || flushTimer) return;
  flushTimer = setTimeout(() => void flushNow(), FLUSH_DEBOUNCE_MS);
  if (!maxWaitTimer) maxWaitTimer = setTimeout(() => void flushNow(), FLUSH_MAX_WAIT_MS);
}

function flushNow(): void {
  clearTimers();
  void flushHistorySync();
}

// —— 对外入口（db.ts 写点挂接） ——

export function enqueueHistoryEntry(entry: HistoryEntry): void {
  pendingHistory.set(entry.id, entry);
  pendingDeleteHistory.delete(entry.id);
  scheduleFlush();
}

export function enqueueProgressEntry(entry: ProgressEntry): void {
  pendingProgress.set(entry.key, entry);
  pendingDeleteProgress.delete(entry.key);
  scheduleFlush();
}

export function enqueueHistoryDelete(id: string): void {
  pendingHistory.delete(id);
  pendingDeleteHistory.add(id);
  scheduleFlush();
}

export function enqueueProgressDelete(key: string): void {
  pendingProgress.delete(key);
  pendingDeleteProgress.add(key);
  scheduleFlush();
}

export function enqueueHistoryClear(): void {
  pendingHistory.clear();
  pendingProgress.clear();
  pendingDeleteHistory.clear();
  pendingDeleteProgress.clear();
  pendingClearAll = true;
  clearRevision += 1;
  scheduleFlush();
}

/** 全量拉取并合并到本地。返回是否成功（成功且未禁用）。 */
export async function syncPull(opts?: { timeoutMs?: number }): Promise<boolean> {
  if (disabled) return false;
  try {
    const res = await fetchWithTimeout('/api/history', opts?.timeoutMs ?? PULL_TIMEOUT_MS);
    if (await isSyncDisabled(res)) return false;
    if (!res.ok) return false;
    const payload = (await res.json()) as { history?: HistoryEntry[]; progress?: ProgressEntry[] };
    const [localHistory, localProgress] = await Promise.all([
      db.history.toArray(),
      db.progress.toArray(),
    ]);
    if (pendingClearAll) return true;
    const remoteHistory = (payload.history ?? []).filter((entry) => !pendingDeleteHistory.has(entry.id));
    const remoteProgress = (payload.progress ?? []).filter((entry) => !pendingDeleteProgress.has(entry.key));
    enqueueLocalChanges(localHistory, localProgress, remoteHistory, remoteProgress);
    const mergedHistory = mergeHistoryEntries(localHistory, remoteHistory, pendingHistory.size > 0 ? new Set(pendingHistory.keys()) : new Set());
    const mergedProgress = mergeProgressEntries(localProgress, remoteProgress, pendingProgress.size > 0 ? new Set(pendingProgress.keys()) : new Set());
    await Promise.all([
      mergedHistory.length > 0 ? db.history.bulkPut(mergedHistory) : Promise.resolve(),
      mergedProgress.length > 0 ? db.progress.bulkPut(mergedProgress) : Promise.resolve(),
    ]);
    return true;
  } catch {
    return false;
  }
}

// —— 内部：推送 ——

/** Serialize requests so clears cannot overtake newer writes. */
export function flushHistorySync(): Promise<void> {
  if (flushing) return flushing;
  flushing = flush().finally(() => {
    flushing = null;
    const hasPending = pendingHistory.size > 0 || pendingProgress.size > 0 ||
      pendingDeleteHistory.size > 0 || pendingDeleteProgress.size > 0 || pendingClearAll;
    if (!disabled && hasPending && !flushTimer) scheduleFlush();
  });
  return flushing;
}

/** Retry after authentication/network recovery and backfill local-only records. */
export async function resumeHistorySync(): Promise<void> {
  disabled = false;
  await syncPull();
  await flushHistorySync();
}

/** Queue only missing/newer local records, preserving pending deletions. */
function enqueueLocalChanges(
  history: HistoryEntry[], progress: ProgressEntry[],
  remoteHistory: HistoryEntry[], remoteProgress: ProgressEntry[]
): void {
  const historyTimes = new Map(remoteHistory.map((entry) => [entry.id, entry.timestamp]));
  const progressTimes = new Map(remoteProgress.map((entry) => [entry.key, entry.updatedAt]));
  for (const entry of history) {
    if (!pendingDeleteHistory.has(entry.id) && entry.timestamp > (historyTimes.get(entry.id) ?? -1)) {
      if (!pendingHistory.has(entry.id)) pendingHistory.set(entry.id, entry);
    }
  }
  for (const entry of progress) {
    if (!pendingDeleteProgress.has(entry.key) && entry.updatedAt > (progressTimes.get(entry.key) ?? -1)) {
      if (!pendingProgress.has(entry.key)) pendingProgress.set(entry.key, entry);
    }
  }
  scheduleFlush();
}

async function flush(): Promise<void> {
  if (disabled) return;
  const hasHistoryOps = pendingHistory.size > 0 || pendingDeleteHistory.size > 0 || pendingClearAll;
  const hasProgressOps = pendingProgress.size > 0 || pendingDeleteProgress.size > 0 || pendingClearAll;

  const historyBatch = [...pendingHistory.values()];
  const progressBatch = [...pendingProgress.values()];
  const deleteHistory = [...pendingDeleteHistory];
  const deleteProgress = [...pendingDeleteProgress];
  const clearAll = pendingClearAll;
  const revision = clearRevision;
  const mutations = mutationRevision;

  let historyOk = true;
  let progressOk = true;

  if (hasHistoryOps) {
    historyOk = await postJson('/api/history', {
      history: historyBatch,
      deleteHistory,
      clearAll,
    });
  }
  if (hasProgressOps && (!clearAll || historyOk)) {
    progressOk = await postJson('/api/progress', {
      progress: progressBatch,
      deleteProgress: clearAll ? undefined : deleteProgress,
    });
  }

  if (clearAll && !historyOk) progressOk = false;
  acknowledgeBatch(historyBatch, progressBatch, deleteHistory, deleteProgress, {
    historyOk, progressOk, revision, mutations,
  });
  persistQueue();
  if (!disabled && (!historyOk || !progressOk)) {
    clearTimers();
    flushTimer = setTimeout(() => flushNow(), RETRY_DELAY_MS);
  }
}

/** Acknowledge only the snapshot sent, never newer edits queued during a request. */
function acknowledgeBatch(
  historyBatch: HistoryEntry[], progressBatch: ProgressEntry[],
  deleteHistory: string[], deleteProgress: string[],
  result: { historyOk: boolean; progressOk: boolean; revision: number; mutations: number }
): void {
  const { historyOk, progressOk, revision, mutations } = result;
  if (historyOk) {
    for (const entry of historyBatch) {
      if (pendingHistory.get(entry.id) === entry) pendingHistory.delete(entry.id);
    }
    if (mutations === mutationRevision) {
      for (const id of deleteHistory) pendingDeleteHistory.delete(id);
    }
  }
  if (progressOk) {
    for (const entry of progressBatch) {
      if (pendingProgress.get(entry.key) === entry) pendingProgress.delete(entry.key);
    }
    if (mutations === mutationRevision) {
      for (const key of deleteProgress) pendingDeleteProgress.delete(key);
    }
  }
  // The history endpoint clears both tables; do not repeat it after a progress-only failure.
  if (historyOk && revision === clearRevision) pendingClearAll = false;
}

async function postJson(url: string, body: unknown): Promise<boolean> {
  if (disabled) return false;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, 10_000, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return false; // 断网/网络错误：保留 pending，下次重试
  }
  if (await isSyncDisabled(res)) return false;
  return res.ok;
}

/** Only an explicit missing-database response disables sync, not an auth 503. */
async function isSyncDisabled(res: Response): Promise<boolean> {
  if (res.status !== 503) return false;
  const payload = await res.clone().json().catch(() => null);
  disabled = payload?.syncEnabled === false;
  return disabled;
}

async function fetchWithTimeout(url: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}
