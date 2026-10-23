'use strict';

/**
 * LibreTV 桌面版预加载脚本（contextIsolation 桥接，供页面读取桌面环境信息）。
 * 页面本身不依赖桌面能力，这里只提供基础元信息，保持安全基线：
 * 不开放 Node API、不暴露 ipcRenderer。
 */

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  isDesktop: true,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
