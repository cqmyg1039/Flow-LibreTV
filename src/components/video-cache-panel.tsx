'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  clearVideoCache,
  getCacheSummary,
  loadCacheSettings,
  saveCacheSettings,
  type CacheSummary,
} from '@/lib/video-cache';
import { ToggleRow } from './settings-shared';
import { useToast } from './toast';

/** 格式化缓存字节数；入参为实际存储字节，展示统一使用二进制单位。 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

/** 管理缓存摘要与清理；失败保留原摘要并提示，不让按钮一直处于加载状态。 */
function useCacheSummary() {
  const [summary, setSummary] = useState<CacheSummary>({
    segments: 0,
    bytes: 0,
    episodes: 0,
  });
  const [clearing, setClearing] = useState(false);
  const { toast } = useToast();
  const refresh = useCallback(() => {
    void getCacheSummary().then(setSummary);
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  const clear = async () => {
    setClearing(true);
    try {
      await clearVideoCache();
      refresh();
    } catch {
      toast('缓存清理失败，请重试', 'error');
    } finally {
      setClearing(false);
    }
  };
  return { summary, clearing, clear };
}

/** 本地缓存开关与用量；关闭立即停止预取，已有分片保留到用户主动清理。 */
export function VideoCachePanel() {
  const [enabled, setEnabled] = useState(() => loadCacheSettings().enabled);
  const { summary, clearing, clear } = useCacheSummary();
  return (
    <div className="space-y-3 pt-3 mt-3 border-t border-line">
      <ToggleRow
        label="片段本地缓存"
        description="暂停或观看时把后续分片缓存到浏览器本地，关闭后停止读写缓存，已有内容保留到主动清理"
        checked={enabled}
        onChange={(value) => {
          const next = saveCacheSettings({ enabled: value });
          setEnabled(next.enabled);
        }}
      />
      <div className="flex items-center justify-between text-xs text-faint">
        <span>
          已缓存 {summary.segments} 个分片 · {formatBytes(summary.bytes)} ·{' '}
          {summary.episodes} 集
        </span>
        <button
          type="button"
          className="px-2 py-1 rounded bg-chip text-content hover:bg-hover transition-colors disabled:opacity-50"
          disabled={clearing || summary.segments === 0}
          onClick={clear}
        >
          清理缓存
        </button>
      </div>
    </div>
  );
}
