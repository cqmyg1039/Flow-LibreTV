'use client';

import { create } from 'zustand';

import type { UpdaterApi, UpdaterState } from './updater-types';

interface UpdaterStore {
  state: UpdaterState | null;
  promptOpen: boolean;
  receive: (state: UpdaterState) => void;
  dismiss: () => void;
  show: () => void;
}

/** 共享更新状态；revision 拒绝订阅后到达的陈旧快照。@param 无参数 */
export const useUpdaterStore = create<UpdaterStore>((set) => ({
  state: null,
  promptOpen: false,
  receive: (state) =>
    set((previous) => {
      if (previous.state && state.revision <= previous.state.revision) return previous;
      const changed = previous.state?.status !== state.status;
      const announce = changed && ['available', 'downloaded'].includes(state.status);
      const manualError = changed && state.status === 'error' && state.manual;
      return { state, promptOpen: previous.promptOpen || announce || manualError };
    }),
  dismiss: () => set({ promptOpen: false }),
  show: () => set({ promptOpen: true }),
}));

/** 执行白名单命令并吸收 IPC 拒绝；错误不刷新或中断播放。@param action 更新命令 */
export async function runUpdaterAction(action: 'check' | 'download' | 'install') {
  const api = window.libreUpdater;
  if (!api) return;
  const store = useUpdaterStore.getState();
  if (store.state && ['available', 'downloading', 'downloaded'].includes(store.state.status)) {
    store.show();
  }
  try {
    await api[action]();
  } catch {
    reportBridgeError(true);
  }
}

/** IPC 失败仅展示通用信息，不把系统路径或内部错误暴露给页面。@param manual 是否用户发起 */
function reportBridgeError(manual: boolean) {
  const store = useUpdaterStore.getState();
  const previous = store.state;
  useUpdaterStore.setState({
    state: {
      revision: previous?.revision ?? -1,
      currentVersion: previous?.currentVersion ?? '',
      supported: previous?.supported ?? false,
      status: 'error',
      manual,
      message: '无法连接桌面更新服务，请重新打开应用后重试。',
    },
    promptOpen: manual,
  });
}

/** 先订阅再拉取快照，防止启动事件丢失；卸载后忽略迟到响应。@param api preload 更新接口 */
export function connectUpdater(api: UpdaterApi) {
  let active = true;
  const receive = (state: UpdaterState) => {
    if (active) useUpdaterStore.getState().receive(state);
  };
  const unsubscribe = api.onState(receive);
  void api
    .getState()
    .then(receive)
    .catch(() => {
      if (active) reportBridgeError(false);
    });
  return () => {
    active = false;
    unsubscribe();
  };
}
