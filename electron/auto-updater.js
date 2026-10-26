'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { app, dialog, ipcMain } = require('electron');
const log = require('electron-log/main');
const { autoUpdater } = require('electron-updater');

const { createUpdateJournal } = require('./update-journal');
const { createUpdaterController, isTrustedSender } = require('./updater');

/** 注册更新 IPC 和启动检查；仅 NSIS 安装版启用。@param {object} options 窗口、源和服务退出依赖 */
function initAutoUpdater({ getWindow, origin, stopServer }) {
  const supported =
    process.platform === 'win32' &&
    app.isPackaged &&
    fs.existsSync(path.join(process.resourcesPath, 'libretv-installed')) &&
    fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'));
  const journal = createUpdateJournal({
    directory: app.getPath('userData'),
    currentVersion: app.getVersion(),
    logger: log,
  });
  const controller = createUpdaterController({
    autoUpdater,
    supported,
    currentVersion: app.getVersion(),
    logger: log,
    stopServer,
    beforeInstall: journal.record,
    broadcast: (state) => {
      const window = getWindow();
      if (window && !window.isDestroyed()) window.webContents.send('updater:state', state);
    },
    onInstallError: () => {
      dialog.showErrorBox(
        'LibreTV 更新未完成',
        '无法完成更新，安装已中止。应用将退出，请重新打开，或从 GitHub Releases 手动安装。'
      );
      app.quit();
    },
  });
  registerHandlers(controller, getWindow, origin);
  log.info(`[updater] version=${app.getVersion()} supported=${supported}`);
  if (!supported) return;
  const failure = journal.recover();
  if (failure) controller.restoreFailure(failure);
  else void controller.check(false);
}

/** IPC 只返回普通对象，并在每次调用时校验发送者。@param {object} controller 状态机 @param {Function} getWindow 窗口 getter @param {string} origin 本地源 */
function registerHandlers(controller, getWindow, origin) {
  const handlers = {
    'updater:get-state': () => controller.getState(),
    'updater:check': () => controller.check(true),
    'updater:download': () => controller.download(),
    'updater:install': () => controller.install(),
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event) => {
      if (!isTrustedSender(event, getWindow(), origin)) throw new Error('拒绝不可信的更新请求');
      return handler();
    });
  }
}

module.exports = { initAutoUpdater };
