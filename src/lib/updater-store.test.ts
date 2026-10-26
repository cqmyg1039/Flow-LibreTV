import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { connectUpdater, runUpdaterAction, useUpdaterStore } from './updater-store';
import type { UpdaterApi, UpdaterState } from './updater-types';

const INITIAL_STATE: UpdaterState = {
  revision: 0,
  currentVersion: '2.19.8',
  supported: true,
  status: 'idle',
  manual: false,
};

beforeEach(() => useUpdaterStore.setState({ state: null, promptOpen: false }));
afterEach(() => vi.unstubAllGlobals());

describe('共享更新展示状态', () => {
  it('自动检查无更新或失败不弹窗，手动错误才显示', () => {
    const { receive } = useUpdaterStore.getState();
    receive({ ...INITIAL_STATE, status: 'not-available' });
    expect(useUpdaterStore.getState().promptOpen).toBe(false);
    receive({ ...INITIAL_STATE, revision: 1, status: 'error' });
    expect(useUpdaterStore.getState().promptOpen).toBe(false);
    receive({ ...INITIAL_STATE, revision: 2, status: 'checking', manual: true });
    receive({ ...INITIAL_STATE, revision: 3, status: 'error', manual: true });
    expect(useUpdaterStore.getState().promptOpen).toBe(true);
  });

  it('关闭提示不清除下载，进度不会重开；下载完成才重新提示', () => {
    const { receive, dismiss } = useUpdaterStore.getState();
    receive({ ...INITIAL_STATE, status: 'available' });
    expect(useUpdaterStore.getState().promptOpen).toBe(true);
    receive({ ...INITIAL_STATE, revision: 1, status: 'downloading', percent: 0 });
    dismiss();
    receive({ ...INITIAL_STATE, revision: 2, status: 'downloading', percent: 50 });
    expect(useUpdaterStore.getState()).toMatchObject({ promptOpen: false, state: { percent: 50 } });
    receive({ ...INITIAL_STATE, revision: 3, status: 'downloaded' });
    expect(useUpdaterStore.getState().promptOpen).toBe(true);
  });

  it('订阅先到、旧快照后到时不回退，并清理订阅', async () => {
    let snapshot!: (state: UpdaterState) => void;
    let callback!: (state: UpdaterState) => void;
    const unsubscribe = vi.fn();
    const api: UpdaterApi = {
      check: async () => ({ ok: true }),
      download: async () => ({ ok: true }),
      install: async () => ({ ok: true }),
      getState: () =>
        new Promise<UpdaterState>((resolve) => {
          snapshot = resolve;
        }),
      onState: (listener: (state: UpdaterState) => void) => {
        callback = listener;
        return unsubscribe;
      },
    };
    const disconnect = connectUpdater(api);
    callback({ ...INITIAL_STATE, revision: 2, status: 'available', version: '2.19.9' });
    snapshot(INITIAL_STATE);
    await Promise.resolve();
    expect(useUpdaterStore.getState().state?.status).toBe('available');
    disconnect();
    callback({ ...INITIAL_STATE, revision: 3, status: 'error' });
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(useUpdaterStore.getState().state?.status).toBe('available');
  });

  it('IPC 拒绝被捕获且不污染主进程 revision', async () => {
    useUpdaterStore.getState().receive(INITIAL_STATE);
    vi.stubGlobal('window', {
      libreUpdater: { check: vi.fn().mockRejectedValue(new Error('internal')) },
    });
    await expect(runUpdaterAction('check')).resolves.toBeUndefined();
    expect(useUpdaterStore.getState()).toMatchObject({
      promptOpen: true,
      state: { status: 'error', revision: 0 },
    });
    useUpdaterStore.getState().receive({ ...INITIAL_STATE, revision: 1, status: 'checking' });
    expect(useUpdaterStore.getState().state?.status).toBe('checking');
  });

  it('普通网页调用不产生异常或更新界面', async () => {
    vi.stubGlobal('window', {});
    await expect(runUpdaterAction('check')).resolves.toBeUndefined();
    expect(useUpdaterStore.getState().state).toBeNull();
  });
});
