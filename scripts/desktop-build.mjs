/**
 * LibreTV 桌面版（Windows exe）一键打包脚本。
 *
 * 流程：
 *  1. DOCKER_BUILD=1 npm run build        → 生成 .next/standalone（含 server.js / .next / node_modules / .env）
 *  2. 拷贝 .next/static → standalone/.next/static（standalone 模式不自动包含静态资源）
 *  3. electron-builder --win              → 产出 release/LibreTV Setup-x.y.z.exe（NSIS 安装包）
 *
 * 国内镜像已内置（npmmirror），避免 Electron/打包二进制下载超时。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

process.env.ELECTRON_MIRROR ||= 'https://npmmirror.com/mirrors/electron/';
process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||= 'https://npmmirror.com/mirrors/electron-builder-binaries/';

function run(cmd, args, opts = {}) {
  console.log(`\n==> ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    cwd: root,
    shell: process.platform === 'win32',
    ...opts,
  });
  if (res.status !== 0) {
    console.error(`✗ 命令失败（exit ${res.status}）: ${cmd} ${args.join(' ')}`);
    process.exit(res.status ?? 1);
  }
}

// 1. standalone 构建
run('npm', ['run', 'build'], { env: { ...process.env, DOCKER_BUILD: '1' } });

// 2. 拷贝静态资源（standalone 不自动包含）
const standaloneDir = path.join(root, '.next', 'standalone');
const staticSrc = path.join(root, '.next', 'static');
const staticDst = path.join(standaloneDir, '.next', 'static');
if (!fs.existsSync(staticDst)) {
  console.log('\n==> 拷贝 .next/static → standalone/.next/static');
  fs.cpSync(staticSrc, staticDst, { recursive: true });
} else {
  console.log('\n==> .next/static 已存在，跳过拷贝');
}

// 2.1 移除 ws 的可选原生加速模块（bufferutil / utf-8-validate）：
//     它们需要按 Electron ABI 重编译（依赖 Visual Studio），缺失时 ws 自动回退纯 JS 实现，
//     避免 node-gyp 失败且不引入 ABI 兼容风险。
for (const mod of ['bufferutil', 'utf-8-validate']) {
  const p = path.join(standaloneDir, 'node_modules', mod);
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
    console.log(`==> 移除可选原生模块 node_modules/${mod}（ws 将使用纯 JS 实现）`);
  }
}

// 3. electron-builder 打包（NSIS 安装包）
run('npx', ['electron-builder', '--win']);

// 4. 列出产物
const releaseDir = path.join(root, 'release');
console.log('\n==============================================');
console.log('打包完成，产物目录 release/:');
for (const f of fs.readdirSync(releaseDir).filter((n) => /\.(exe|blockmap|yml)$/.test(n))) {
  const size = fs.statSync(path.join(releaseDir, f)).size / (1024 * 1024);
  console.log(`  - ${f}  (${size.toFixed(1)} MB)`);
}
console.log('==============================================');
