'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import { useFocusTrap } from './use-focus-trap';
import { connectUpdater, runUpdaterAction, useUpdaterStore } from '@/lib/updater-store';
import type { UpdaterState } from '@/lib/updater-types';

const STATUS_LABELS = {
  idle: '可手动检查更新',
  unsupported: '自动更新仅支持 NSIS 安装版，请安装正式安装包后使用。',
  checking: '正在检查更新…',
  'not-available': '当前已是最新版本',
  available: '发现新版本',
  downloading: '正在下载更新',
  downloaded: '更新已就绪',
  installing: '正在停止本地服务并启动安装器…',
  error: '更新失败',
};

/** 全局仅订阅一次桌面事件；网页端不挂载更新界面。@param 无参数 */
export function UpdaterManager() {
  useEffect(() => {
    if (window.libreUpdater) return connectUpdater(window.libreUpdater);
  }, []);
  return <UpdaterPrompt />;
}

/** 设置抽屉的桌面更新入口，复用全局状态。@param 无参数 */
export function UpdaterSettings() {
  const state = useUpdaterStore((store) => store.state);
  if (!state) return null;
  return (
    <section className="mt-6 rounded-xl border border-line bg-surface-raised p-4 space-y-3">
      <h3 className="text-sm font-semibold text-content">桌面应用更新</h3>
      <p className="text-xs text-muted">当前版本 v{state.currentVersion || '未知'}</p>
      <UpdaterDetails state={state} />
      <UpdaterActions state={state} />
      <p className="text-xs text-faint">下载后不会自动安装，需要点击“重启安装”。</p>
    </section>
  );
}

/** 可关闭的更新弹窗；下载继续，播放页面不刷新。@param 无参数 */
function UpdaterPrompt() {
  const { state, promptOpen, dismiss } = useUpdaterStore();
  const panelRef = useRef<HTMLDivElement>(null);
  const open =
    promptOpen &&
    !!state &&
    !['idle', 'unsupported', 'checking', 'not-available'].includes(state.status);
  useFocusTrap(open, panelRef);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        dismiss();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, dismiss]);
  if (!open || !state) return null;
  return createPortal(
    <UpdaterDialog state={state} panelRef={panelRef} dismiss={dismiss} />,
    document.body
  );
}

/** 更新弹窗内容，与订阅和焦点生命周期分离。@param props 状态、面板引用和关闭回调 */
function UpdaterDialog({
  state,
  panelRef,
  dismiss,
}: {
  state: UpdaterState;
  panelRef: RefObject<HTMLDivElement | null>;
  dismiss: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4">
      <div
        ref={panelRef}
        tabIndex={-1}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="updater-title"
        className="w-full max-w-md rounded-2xl border border-line bg-surface p-5 shadow-xl space-y-4"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 id="updater-title" className="font-semibold text-content">
            LibreTV 应用更新
          </h2>
          <button className="btn-ghost text-sm" onClick={dismiss} aria-label="关闭更新提示">
            关闭
          </button>
        </div>
        <UpdaterDetails state={state} />
        <div className="flex flex-wrap gap-2">
          <UpdaterActions state={state} />
          <button className="btn-ghost" onClick={dismiss}>
            稍后再说
          </button>
        </div>
        <p className="text-xs text-faint">重启安装会停止当前播放；关闭提示不影响下载。</p>
      </div>
    </div>
  );
}

/** 纯文本更新说明与进度；不注入更新源返回的 HTML。@param state 主进程状态 */
function UpdaterDetails({ state }: { state: UpdaterState }) {
  return (
    <div className="space-y-2 text-sm text-muted">
      <p role="status">
        {STATUS_LABELS[state.status]}
        {state.version ? `（v${state.version}）` : ''}
      </p>
      {state.status === 'error' && <p className="text-danger">{state.message}</p>}
      {state.status === 'available' && state.notes && (
        <pre className="max-h-52 overflow-auto whitespace-pre-wrap font-sans text-xs">
          {state.notes}
        </pre>
      )}
      {state.status === 'downloading' && (
        <>
          <progress
            className="w-full accent-accent"
            value={state.percent ?? 0}
            max={100}
            aria-label="更新下载进度"
          />
          <p>
            {(state.percent ?? 0).toFixed(1)}% ·{' '}
            {((state.bytesPerSecond ?? 0) / 1024 / 1024).toFixed(1)} MB/s
          </p>
        </>
      )}
    </div>
  );
}

/** 按状态暴露可用操作；最终状态守卫仍在主进程。@param state 主进程状态 */
function UpdaterActions({ state }: { state: UpdaterState }) {
  if (!state.supported) return null;
  const action =
    state.status === 'available' ? 'download' : state.status === 'downloaded' ? 'install' : 'check';
  const busy = ['checking', 'downloading', 'installing'].includes(state.status);
  const label = action === 'download' ? '立即下载' : action === 'install' ? '重启安装' : '检查更新';
  return (
    <button className="btn-primary" disabled={busy} onClick={() => void runUpdaterAction(action)}>
      {label}
    </button>
  );
}
