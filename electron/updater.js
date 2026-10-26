'use strict';

/** 将更新说明归一化为纯文本；不向页面注入远端 HTML。@param {unknown} notes 更新说明 */
function normalizeNotes(notes) {
  if (typeof notes === 'string') return notes.slice(0, 20000);
  if (!Array.isArray(notes)) return '';
  return notes
    .map((item) => (typeof item?.note === 'string' ? `${item.version || ''}\n${item.note}` : ''))
    .join('\n\n')
    .slice(0, 20000);
}

/** 绑定 updater 事件；仅广播可序列化的领域状态。@param {object} options 事件依赖 */
function bindUpdaterEvents({ autoUpdater, update, fail }) {
  autoUpdater.on('update-available', (info) => {
    update({
      status: 'available',
      version: info.version,
      notes: normalizeNotes(info.releaseNotes),
    });
  });
  autoUpdater.on('update-not-available', () => update({ status: 'not-available' }));
  autoUpdater.on('download-progress', (progress) => {
    update({
      status: 'downloading',
      percent: Math.min(100, Math.max(0, Number(progress.percent) || 0)),
      bytesPerSecond: Math.max(0, Number(progress.bytesPerSecond) || 0),
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    update({ status: 'downloaded', version: info.version, percent: 100 });
  });
  autoUpdater.on('error', fail);
}

/** 执行安装：先等本地服务退出，再拉起安装器。@param {object} options 安装依赖 */
async function installUpdate({ autoUpdater, stopServer, beforeInstall, update, getState, fail }) {
  update({ status: 'installing', manual: true });
  try {
    await stopServer();
  } catch (error) {
    fail(error, false);
    return { ok: false };
  }
  if (getState().status !== 'installing') return { ok: false };
  try {
    beforeInstall(getState().version);
    autoUpdater.quitAndInstall(false, true);
    return { ok: getState().status !== 'error' };
  } catch (error) {
    fail(error);
    return { ok: false };
  }
}

/** 创建主进程权威状态机；依赖注入便于无 Electron 环境测试。@param {object} options 更新依赖 */
function createUpdaterController(options) {
  const { autoUpdater, supported, currentVersion, broadcast, logger, onInstallError } = options;
  let state = {
    revision: 0,
    currentVersion,
    supported,
    status: supported ? 'idle' : 'unsupported',
    manual: false,
  };
  const getState = () => ({ ...state });
  const update = (patch) => {
    state = { ...state, ...patch, revision: state.revision + 1 };
    broadcast(getState());
  };
  const fail = (error, exitOnInstallError = true) => {
    logger.error('[updater]', error);
    if (state.status === 'error') return;
    const installing = state.status === 'installing';
    update({
      status: 'error',
      message: '更新失败，请检查网络后重试，或从 GitHub Releases 手动安装。',
    });
    if (installing && exitOnInstallError) onInstallError();
  };
  Object.assign(autoUpdater, {
    logger,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    autoRunAppAfterInstall: true,
    allowPrerelease: false,
    allowDowngrade: false,
  });
  bindUpdaterEvents({ autoUpdater, update, fail });
  return {
    getState,
    restoreFailure: (message) => update({ status: 'error', manual: true, message }),
    check: (manual = true) => checkUpdate({ autoUpdater, getState, update, fail }, manual),
    download: () => downloadUpdate({ autoUpdater, getState, update, fail }),
    install: () => {
      if (state.status !== 'downloaded') return Promise.resolve({ ok: false });
      return installUpdate({ ...options, update, getState, fail });
    },
  };
}

/** 检查更新；忙碌时复用状态，禁止覆盖下载/待安装结果。@param {object} ctx 状态上下文 @param {boolean} manual 手动检查 */
async function checkUpdate(ctx, manual) {
  const { autoUpdater, getState, update, fail } = ctx;
  const state = getState();
  if (!state.supported) return { ok: false };
  if (['checking', 'available', 'downloading', 'downloaded', 'installing'].includes(state.status)) {
    if (manual) update({ manual: true });
    return { ok: true };
  }
  update({ status: 'checking', manual, message: '', version: '', notes: '', percent: 0 });
  try {
    await autoUpdater.checkForUpdates();
    return { ok: getState().status !== 'error' };
  } catch (error) {
    fail(error);
    return { ok: false };
  }
}

/** 下载更新；同步切换状态防止重复下载，不传递原始 updater 结果。@param {object} ctx 状态上下文 */
async function downloadUpdate({ autoUpdater, getState, update, fail }) {
  if (getState().status !== 'available') return { ok: false };
  update({ status: 'downloading', manual: true, percent: 0, bytesPerSecond: 0 });
  try {
    await autoUpdater.downloadUpdate();
    return { ok: getState().status !== 'error' };
  } catch (error) {
    fail(error);
    return { ok: false };
  }
}

/** 仅信任主窗口的顶层本地页面，拒绝子框架和外部导航。@param {object} event IPC 事件 @param {object} window 主窗口 @param {string} origin 本地源 */
function isTrustedSender(event, window, origin) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents) return false;
  const frame = event.senderFrame;
  if (!frame || frame !== window.webContents.mainFrame) return false;
  try {
    return new URL(frame.url).origin === origin;
  } catch {
    return false;
  }
}

module.exports = { createUpdaterController, isTrustedSender, normalizeNotes };
