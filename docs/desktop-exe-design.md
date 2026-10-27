# LibreTV Windows 桌面版（exe）打包 设计方案

> 分支：feature/windows-exe　基于 main（历史跨设备同步已上线）
> 目标：研究并落地「LibreTV 打包成 Windows 可运行 exe」——双击即用，无需 Node 环境。

## 1. 结论

**可行，推荐 Electron + Next standalone + electron-builder。**

- Next.js 15 已原生支持 `output: 'standalone'`（项目已有 DOCKER_BUILD 开关），桌面版不需要改业务代码；
- Electron 用 Chromium 内核，项目现有的 ArtPlayer / hls.js / IndexedDB / 历史同步 API 全部原生可用；
- 桌面版跑本地 Next server（127.0.0.1）→ 与网页版同一套代码，同一份云端历史（Neon）互通。

## 2. 方案选型对比

| 方案 | 体积 | 语言/工具链 | Next.js 集成 | 结论 |
|---|---|---|---|---|
| **Electron + electron-builder** ⭐ | ~100-120MB（含 Chromium） | 纯 JS/TS，前端栈即可 | standalone 已实验通过 | **推荐** |
| Tauri v2 | ~8-15MB | 需 Rust 工具链；Next 需 sidecar 起 node | 复杂、Windows 原生依赖 | 备选（在意体积时） |
| PWA 安装 | 0（浏览器） | — | 不算 exe，不符需求 | 否 |
| pkg 单文件 node | ~60MB | 无窗口/托盘，需自造壳 | 体验差 | 否 |

## 3. 架构

```
┌──────────────────────────────────────────────┐
│  Electron 主进程（main.js）                     │
│  ├─ 启动 Next standalone server（node 子进程）    │
│  │   .next/standalone/server.js，PORT=8899      │
│  │   （端口占用则自动找空闲端口）                    │
│  └─ BrowserWindow（Chromium）                  │
│      contextIsolation:true / nodeIntegration:false │
│      loadURL(http://127.0.0.1:PORT)            │
│  └─ 退出时优雅结束 server 子进程                   │
└──────────────────────────────────────────────┘
           └── 同一份代码/同一份 .env ──> 云端历史（Neon）与网页版互通
```

## 4. 已验证事实（2026-10-23 实验）

| 项 | 结果 |
|---|---|
| `DOCKER_BUILD=1 npm run build` 生成 standalone | ✅ 通过 |
| standalone 冒烟（node server.js） | ✅ `/api/status` 200、`/` 200、14 个源从 .env 自动加载 |
| `.env`（PASSWORD/14源/POSTGRES_URL）随 standalone 打包 | ✅ 自动包含（文件追踪） |
| 坑①：多 lockfile → workspace root 误判 | ⚠️ 已修复：`next.config.ts` 显式 `outputFileTracingRoot: path.join(__dirname)`，否则产物被塞进 `.next/standalone/demo/LibreTV-main/` |
| 坑②：standalone 不自动带 `.next/static` | ⚠️ 打包脚本需 `Copy-Item .next/static → standalone/.next/static`（构建/发布脚本处理） |

## 5. 打包流程（electron-builder）

1. `DOCKER_BUILD=1 npm run build` → `.next/standalone` + 拷 `static`
2. `electron/` 目录：`main.js`（主进程）、`preload.js`（可选）
3. package.json 增 `"main": "electron/main.js"` + `build`（electron-builder 配置）
4. `electron-builder --win nsis` → 产出 `LibreTV Setup-x.y.z.exe`（NSIS 安装包）
5. 分发：GitHub Releases 附件（scripts/create-release.py 一键发布）

## 6. 国内构建环境（关键）

| 依赖 | 坑 | 解决 |
|---|---|---|
| Electron 二进制下载 | 官方源慢/失败 | `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` |
| electron-builder 依赖二进制（nsis/winCodeSign） | 国外源慢 | `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/` |
| npm 依赖 | — | `--registry=https://registry.npmmirror.com` |

## 7. 已知风险与对策

| 风险 | 说明 | 对策 |
|---|---|---|
| Windows Defender 误报 | 未签名的 exe 常见（SmartScreen 提示"未知发布者"） | 接受提示或购买代码签名证书（¥500+/年，自用不必）；给家人一个"第一次点更多信息→仍要运行"说明 |
| 包体积 ~120MB | Electron 自带 Chromium | 接受；压缩可选（仅生产调试需要时） |
| 端口冲突 | 8899 被占用 | main.js 探测空闲端口再启动 server（server.js 支持 PORT env） |
| 本地无 POSTGRES_URL | 桌面版历史同步自动降级（503→禁用） | 打包时 .env 预置 Neon 连接串，与网页版共享历史 |
| 升级分发 | 打包新版本后重发 exe | 简单覆盖安装即可（一期不做自动更新） |

## 8. 验收标准

1. 在**无 Node 环境的 Windows 机器**上双击安装包 → 安装 → 启动
2. 打开即进入 LibreTV 首页（本机 localhost 加载），输入密码可看片
3. 搜索/播放/片头片尾跳过/历史记录与进度同步（连接同一 Neon）全部可用
4. 关闭窗口 → 进程完全退出，无残留 node 进程
5. 端口占用时自动切换可用端口，不影响使用

## 9. 实施清单（下一步）

- [ ] `electron/main.js`：启动 standalone server + BrowserWindow + 退出清理 + 空闲端口探测
- [ ] `electron/preload.js`：预留（版本信息展示等）
- [ ] package.json：`main` 字段 + electron 相关 devDependencies + `build` 配置（win: nsis，icon）
- [ ] `scripts/desktop-build.mjs`：standalone 构建 → 拷 static → electron-builder 打包（含国内镜像环境变量）
- [ ] 图标：`build/icon.ico`（256×256，可用现有 Logo 生成）
- [ ] 本机验证：安装包跑一遍，通过验收标准
- [ ] 提交本分支，产出 exe 附件/链接交付用户
