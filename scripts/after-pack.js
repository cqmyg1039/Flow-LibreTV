'use strict';

/**
 * electron-builder afterPack 钩子。
 *
 * 背景：LibreTV 桌面版把 Next standalone 产物（含自带 node_modules）作为 extraResources
 * 携带。electron-builder 在 packaging 阶段会清空 extraResources 中的 node_modules 目录
 * （它只收集应用根目录的依赖，导致 standalone 的完整依赖集被删为空目录），运行时会报
 * MODULE_NOT_FOUND。本钩子在 appOutDir 就绪后（构建安装器之前）把 .next/standalone
 * 的 node_modules 与 static 补回 resources/standalone，保证打包产物完整可运行。
 */

const fs = require('node:fs');
const path = require('node:path');

module.exports = async function afterPack(context) {
  const { appOutDir } = context;
  const root = path.resolve(__dirname, '..');

  const src = {
    nodeModules: path.join(root, '.next', 'standalone', 'node_modules'),
    static: path.join(root, '.next', 'static'),
  };
  const dstDir = path.join(appOutDir, 'resources', 'standalone');

  // node_modules
  if (fs.existsSync(src.nodeModules)) {
    const dstNM = path.join(dstDir, 'node_modules');
    fs.cpSync(src.nodeModules, dstNM, { recursive: true, force: true });
    console.log(`[afterPack] copied node_modules -> ${dstNM}`);
  } else {
    console.warn('[afterPack] WARN: .next/standalone/node_modules not found');
  }

  // static（extraResources 已带，此处兜底）
  if (fs.existsSync(src.static)) {
    const dstStatic = path.join(dstDir, '.next', 'static');
    if (!fs.existsSync(dstStatic)) {
      fs.cpSync(src.static, dstStatic, { recursive: true });
      console.log(`[afterPack] copied static -> ${dstStatic}`);
    }
  }
};
