'use strict';

/**
 * LibreTV 桌面版主进程。
 *
 * 职责：
 * 1. 以 Node 模式（ELECTRON_RUN_AS_NODE=1）启动随包携带的 Next standalone server
 *    （resources/standalone/server.js，由 electron-builder extraResources 拷贝）。
 * 2. 探测空闲端口，轮询 /api/status 确认服务就绪后，用 BrowserWindow 加载 localhost。
 * 3. 退出时优雅结束 server 子进程；单实例锁防止重复启动。
 *
 * 安全基线：contextIsolation=true、nodeIntegration=false、窗口只加载 127.0.0.1。
 */

const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');

/** standalone 产物目录：安装目录/resources/standalone */
function serverDir() {
  return path.join(process.resourcesPath, 'standalone');
}

const SERVER_JS = path.join(serverDir(), 'server.js');

let serverProc = null;
let mainWindow = null;

/** 探测一个空闲的本地端口（listen(0) 让系统分配，随即释放） */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/** 轮询本地服务直到 /api/status 可访问 */
async function waitForServer(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ok = await new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/api/status', timeout: 2000 }, (res) => {
          resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });
      });
      if (ok) return true;
    } catch {
      // 未就绪，继续轮询
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/** 启动 Next standalone server，返回其监听端口 */
async function startServer() {
  const port = await getFreePort();
  serverProc = spawn(process.execPath, [SERVER_JS], {
    cwd: serverDir(),
    env: {
      ...process.env,
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  serverProc.stdout.on('data', (d) => process.stdout.write(`[libretv-server] ${d}`));
  serverProc.stderr.on('data', (d) => process.stderr.write(`[libretv-server] ${d}`));
  serverProc.on('exit', (code) => {
    serverProc = null;
  });

  const ok = await waitForServer(port);
  if (!ok) {
    throw new Error(`本地服务启动超时（端口 ${port}）。可查看上方 [libretv-server] 日志确认原因。`);
  }
  return port;
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 600,
    title: 'LibreTV',
    autoHideMenuBar: true,
    backgroundColor: '#0f1117',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow.loadURL(`http://127.0.0.1:${port}`);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// —— 单实例锁：重复启动时聚焦已有窗口 ——
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      const port = await startServer();
      createWindow(port);
    } catch (err) {
      dialog.showErrorBox('LibreTV 启动失败', String((err && err.message) || err));
      app.quit();
    }
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  if (serverProc) {
    serverProc.kill();
    serverProc = null;
  }
});
