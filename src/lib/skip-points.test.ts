import { describe, expect, it } from 'vitest';
import {
  MIN_SKIP_EPISODE_SECONDS,
  normalizeSkipPoints,
  shouldSkipOp,
  shouldTriggerEd,
  isInOpRange,
} from './skip-points';

describe('normalizeSkipPoints', () => {
  it('duration 未知（直播流）时全部禁用', () => {
    expect(normalizeSkipPoints(60, 3000, 0)).toEqual({ opEnd: 0, edStart: 0 });
    expect(normalizeSkipPoints(60, 3000, Number.NaN)).toEqual({ opEnd: 0, edStart: 0 });
  });

  it('短视频（<90s）禁用全部跳过', () => {
    const short = MIN_SKIP_EPISODE_SECONDS - 1;
    expect(normalizeSkipPoints(10, 70, short)).toEqual({ opEnd: 0, edStart: 0 });
  });

  it('opEnd 超时长 60% 视为无效', () => {
    expect(normalizeSkipPoints(130, 0, 200)).toEqual({ opEnd: 0, edStart: 0 });
    // 恰在比例内保留
    expect(normalizeSkipPoints(119, 0, 200)).toEqual({ opEnd: 119, edStart: 0 });
  });

  it('edStart 距结尾不足 5s 视为无效', () => {
    expect(normalizeSkipPoints(60, 297, 300)).toEqual({ opEnd: 60, edStart: 0 });
    expect(normalizeSkipPoints(60, 290, 300)).toEqual({ opEnd: 60, edStart: 290 });
  });

  it('正常标记原样保留', () => {
    expect(normalizeSkipPoints(75, 2760, 2880)).toEqual({ opEnd: 75, edStart: 2760 });
  });
});

describe('shouldSkipOp', () => {
  it('跨过 opEnd 时触发', () => {
    expect(shouldSkipOp(75, 74.9, 75.5)).toBe(true);
  });

  it('未到或恰在 opEnd 上不触发', () => {
    expect(shouldSkipOp(75, 70, 74)).toBe(false);
    expect(shouldSkipOp(75, 75, 76)).toBe(false);
  });

  it('opEnd 未设置时不触发', () => {
    expect(shouldSkipOp(0, 0, 100)).toBe(false);
  });
});

describe('shouldTriggerEd', () => {
  it('跨过 edStart 且距结尾 >5s 时触发', () => {
    expect(shouldTriggerEd(2760, 2759, 2761, 2880)).toBe(true);
  });

  it('仅跨过一次（prev >= edStart 后不再触发）', () => {
    expect(shouldTriggerEd(2760, 2761, 2770, 2880)).toBe(false);
  });

  it('距结尾不足 5s 视为自然结束不触发', () => {
    expect(shouldTriggerEd(2760, 2759, 2876, 2880)).toBe(false);
  });

  it('edStart 未设置时不触发', () => {
    expect(shouldTriggerEd(0, 0, 100, 200)).toBe(false);
  });
});

describe('isInOpRange', () => {
  it('恢复点在片头区间内为 true', () => {
    expect(isInOpRange(75, 30)).toBe(true);
    expect(isInOpRange(75, 0.5)).toBe(true);
  });

  it('恢复点在 opEnd 之后或未设置时不恢复跳过', () => {
    expect(isInOpRange(75, 76)).toBe(false);
    expect(isInOpRange(0, 30)).toBe(false);
    expect(isInOpRange(75, 0)).toBe(false);
  });
});
