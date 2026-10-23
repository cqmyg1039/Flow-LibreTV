/**
 * 片头片尾跳过的纯逻辑层：边界归一化 + 判定工具。
 * 与播放器 / IndexedDB 解耦，便于单测与复用。
 */

/** 总时长低于该秒数的视频视为短视频，不启用任何跳过（防误跳） */
export const MIN_SKIP_EPISODE_SECONDS = 90;

/** opEnd 超过总时长该比例时视为无效标记 */
export const MAX_OP_RATIO = 0.6;

/** edStart 距视频结尾小于该秒数时视为自然结束，不触发片尾跳过 */
export const MIN_ED_TAIL_SECONDS = 5;

export interface NormalizedSkipPoints {
  opEnd: number;
  edStart: number;
}

/**
 * 边界归一化：
 * - duration 无效（直播流 / 未知）或 < MIN_SKIP_EPISODE_SECONDS → 全部禁用
 * - opEnd 非法（≤0 或超过时长 60%）→ 置 0
 * - edStart 非法（≤0 或距结尾 < 5s）→ 置 0
 */
export function normalizeSkipPoints(opEnd: number, edStart: number, duration: number): NormalizedSkipPoints {
  if (!Number.isFinite(duration) || duration <= 0 || duration < MIN_SKIP_EPISODE_SECONDS) {
    return { opEnd: 0, edStart: 0 };
  }
  return {
    opEnd: opEnd > 0 && opEnd < duration * MAX_OP_RATIO ? opEnd : 0,
    edStart: edStart > 0 && duration - edStart >= MIN_ED_TAIL_SECONDS ? edStart : 0,
  };
}

/**
 * 片头跳过判定：仅在「自然播放单调前进」时由调用方传入 prev/cur。
 * 跨过即跳（prev < opEnd ≤ cur），保证一次触发。
 */
export function shouldSkipOp(opEnd: number, prevTime: number, curTime: number): boolean {
  return opEnd > 0 && prevTime < opEnd && curTime >= opEnd;
}

/**
 * 片尾触发判定：跨过 edStart 且距结尾仍 > 5s 才触发（只触发一次）。
 */
export function shouldTriggerEd(edStart: number, prevTime: number, curTime: number, duration: number): boolean {
  if (edStart <= 0) return false;
  if (!(prevTime < edStart && curTime >= edStart)) return false;
  return Number.isFinite(duration) && duration - curTime >= MIN_ED_TAIL_SECONDS;
}

/**
 * 恢复位置是否落在片头区间内（上次退出在片头里，恢复后应补一次跳过）。
 * saved 需 > 0 且 < opEnd。
 */
export function isInOpRange(opEnd: number, saved: number): boolean {
  return opEnd > 0 && saved > 0 && saved < opEnd;
}
