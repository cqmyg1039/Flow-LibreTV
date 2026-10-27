# LibreTV Windows 桌面版自动升级设计（Spec v1.1）

> 基线版本：2.19.8 ｜ Electron 45 / electron-builder 26（NSIS）/ electron-updater 6.8.11
> 状态：代码已接入，待 Windows 安装包端到端验收；未构建、未上传、未公开发布
> 更新源：`cqmyg1039/Flow-LibreTV` 的公开 GitHub Releases，稳定通道

## 1. 结论与评审修正

采用 **electron-updater + NSIS**，不自研下载校验或补丁算法。当前分支跟踪
`github/feature/windows-exe`，更新源使用该 remote 对应的 `cqmyg1039/Flow-LibreTV`，
不是 `origin` 对应的上游 `LibreSpark/LibreTV`。

v1.0 中必须修正的问题已纳入实现：

- 自动检查无更新不显示空白遮罩；错误和更新提示可关闭，不刷新播放页面。
- 主进程保存权威状态，先订阅后读取快照，使用 revision 防止旧快照覆盖新事件。
- 下载需要用户确认；普通退出不安装，只有明确点击“重启安装”才拉起安装器。
- 安装前等待 standalone 子进程实际退出，不能把 `kill()` 当成已解除文件锁。
- 按 `latest.yml` 读取实际安装包文件名，不硬编码空格或连字符命名。
- 发布前检查版本、大小、SHA512、blockmap、本地及远端标签，不覆盖已公开版本。
- 默认只做本地产物校验；显式参数才创建草稿，人工核对后再公开。
- 不承诺任意下载中断都能续传、NSIS 事务回滚或签名后不再出现 SmartScreen。

## 2. 范围与限制

### v1 包含

- Windows x64 NSIS 安装版启动静默检查，设置抽屉底部提供手动检查入口。
- 新版本提示、纯文本更新说明、确认下载、下载进度、稍后处理、手动重启安装。
- 库提供的 SHA512 校验、可用时的 blockmap 差分下载、差分失败回退全量。
- 主进程日志、IPC 发送者验证、重复操作防护、页面刷新后的状态恢复。

### v1 不包含

- 强制升级、灰度、预发布通道、多架构、自定义资源 patch、事务式回滚。
- 自动公开 GitHub Release、替用户推送提交或标签、内嵌 GitHub PAT。
- 保证任意网络中断后的断点续传；失败后提供重试，缓存复用取决于库及失败阶段。
- 旧版 2.19.7 的自举更新：旧版本没有 updater，首次必须手动安装 2.19.8 或更高版本。

## 3. 更新源与打包

`package.json` 的 `build.publish`：

```json
{
  "provider": "github",
  "owner": "cqmyg1039",
  "repo": "Flow-LibreTV",
  "releaseType": "release"
}
```

- electron-builder 生成 `resources/app-update.yml`；版本来自应用自身的 package 信息，
  不能把 `app-update.yml` 误认为当前版本清单。
- `latest.yml`、它引用的 NSIS 安装包及相应 `.blockmap` 必须作为同一个 Release 的附件发布。
- `desktop:build` 显式使用 `--publish never`，即使设置了 `GH_TOKEN` 也不隐式上传。
- `build/installer.nsh` 在实际安装时写入 `resources/libretv-installed` 标记。
  只有 Windows、`app.isPackaged`、安装标记和 `app-update.yml` 均满足时启用更新。
  `app.isPackaged` 本身不能区分安装版和 `win-unpacked`。
- 保持 `appId`、productName、安装身份及 userData 路径稳定；不要为每次升级更换身份。

GitHub provider 默认通过 HTTPS 获取公开发布信息，不需要向客户端分发令牌。
HTTPS 是生产安全要求，不是 electron-updater 对所有 provider 的硬性协议限制；
本地独立测试可用 HTTP，但不能把本地源写入正式产物。

## 4. 模块与职责

| 文件                            | 职责                                                             |
| ------------------------------- | ---------------------------------------------------------------- |
| `electron/updater.js`           | 可测试的更新状态机、重复操作防护、更新说明归一化、IPC 发送者校验 |
| `electron/auto-updater.js`      | Electron 接线、日志、安装环境识别、IPC 注册、启动静默检查        |
| `electron/update-journal.js`    | 安装意图持久化，下次启动核对实际版本并提示未完成更新             |
| `electron/server-lifecycle.js`  | 停止 standalone，等待 exit，超时/kill 失败时拒绝安装             |
| `electron/main.js`              | 主窗口和本地服务生命周期，限制顶层外部导航及新窗口               |
| `electron/preload.js`           | 仅暴露固定方法和可取消订阅，不开放原始 ipcRenderer 或 Node API   |
| `src/lib/updater-types.ts`      | 渲染进程的状态及桥接接口类型                                     |
| `src/lib/updater-store.ts`      | 全站共享 Zustand 状态、订阅恢复、IPC 错误吸收、弹窗显示状态      |
| `src/components/updater.tsx`    | 全局更新管理器、可关闭提示、设置入口、说明和进度                 |
| `scripts/release-artifacts.mjs` | 本地产物、版本、路径、大小及 SHA512 校验                         |
| `scripts/publish-release.mjs`   | 标签及工作树校验、显式草稿上传、远端附件核对                     |
| `scripts/create-release.py`     | 旧发布入口兼容层，转交安全 Node 发布脚本，不再走旧的直接公开逻辑 |

沿用项目 React、TypeScript、Zustand 结构，使用 kebab-case 文件名。
运行依赖为 electron-updater 和 electron-log；发布脚本复用 updater 声明的 YAML、semver 依赖。

## 5. 状态机与 IPC

```text
unsupported                         非 Windows / 开发 / 未安装
idle -> checking -> not-available   不弹窗，手动检查在设置中反馈
                 -> available -> downloading -> downloaded -> installing
                 -> error            任一步骤失败
```

- 状态包含 revision、currentVersion、supported、status、manual 及按需版本/说明/进度/错误。
- checking、available、downloading、downloaded、installing 时不启动重复检查。
- 仅 available 可开始下载，仅 downloaded 可开始安装；切换状态在异步调用之前完成。
- error 后可重新检查并下载，不承诺从先前中断字节处恢复。
- `updated` 不作为旧进程的终态：进程退出后无法继续收到新安装器的可靠结果。

桥接接口固定为：

```ts
getState(): Promise<UpdaterState>
check(): Promise<{ ok: boolean }>
download(): Promise<{ ok: boolean }>
install(): Promise<{ ok: boolean }>
onState(callback): () => void
```

只传普通可序列化对象，不传 updater 原始检查结果、取消令牌、嵌套 Promise 或本地安装路径。
主进程每次调用都验证：发送者属于当前主窗口、senderFrame 是主 frame、URL origin 是
当前绑定的 `http://127.0.0.1:<固定桌面端口>`。子框架、其他窗口和外部导航均不能调用。

前端先订阅，再拉快照；revision 小于或等于当前状态的快照不覆盖更新事件。
关闭弹窗只关闭展示；下载继续，进度事件不会把弹窗反复打开，下载完成再次提示。
自动检查失败只在设置中反馈，完整错误记录到主进程日志，不打断正常播放。

## 6. 安装与恢复边界

1. 用户点击“重启安装”；立即进入 installing，拒绝重复点击。
2. 停止 standalone 子进程，等待实际 exit，默认 10 秒超时。
3. 停止失败则不调用安装器，显示通用错误并记录日志，不保证服务仍然可用。
4. 成功停止后保存安装意图（源版本和目标版本），然后调用 `quitAndInstall(false, true)`，交由 NSIS 接管，重启后版本来自 `app.getVersion()`。
5. 下次启动时读取并消费安装意图：若仍为源版本则提示上次更新未完成；目标版本启动只记录诊断日志。
6. 服务停止后若应用尚未退出且捕获到安装启动错误，用原生对话框提示重新打开或手动安装，随后退出。

`autoDownload = false`、`autoInstallOnAppQuit = false`、`allowPrerelease = false`、
`allowDowngrade = false`。普通退出不会安装已下载更新。

**不能保证的事项：**

- NSIS 启动后的安装取消、磁盘错误、系统重启等，不一定能反馈给已经退出的原应用。
- 不提供任意安装失败后的自动回滚；保留手动重新安装的恢复方式。
- userData 通常不在覆盖范围内，但持久化 origin、应用身份和数据迁移仍需真实升级验证。
  本项目已保存桌面服务端口，升级应保持这一行为。

## 7. 差分与安全

- blockmap 是块映射元数据，不是一个独立补丁包。
- 差分依赖新旧 blockmap、旧安装器缓存及服务器 Range 支持；首次升级、缓存丢失或
  跨版本升级可能全量下载；保留历史 Release 的附件，不删除旧 blockmap。
- SHA512 确保下载内容与元数据匹配，但不等价于发布者身份认证。
- 强烈建议 Authenticode 签名并保持发布者身份一致；签名不能保证没有 SmartScreen 或 UAC 提示。
- 更新说明只能按纯文本展示，并限制长度；不得使用 dangerouslySetInnerHTML 直接注入远端内容。
- IPC 错误不显示系统路径、下载目录或详细内部堆栈；主进程日志用于诊断。
- 发版前检查 standalone 内容无本地秘密、账号令牌或不应分发的 `.env`，现有构建产物不能直接视为安全发布物。

## 8. 发布流程（人工触发）

### 8.1 产出与验收

首次接入版本号为 2.19.8。后续每次递增版本，提交代码后按仓库既有方式构建：

```powershell
npm ci
npm run desktop:build
npm run desktop:release
```

第三条命令默认 **只校验本地产物，不联网、不上传**。校验包括：

- package.json 为稳定 semver，latest.yml 与之完全匹配。
- 当前仅允许一个 x64 NSIS exe，兼容 path/sha512 字段与 files 条目一致。
- 文件名仅为 release 根目录下的本地文件，拒绝 URL、路径穿越和符号链接逃逸。
- 安装器存在、大小及 SHA512 匹配，blockmap 存在且非空。

当前仓库已有 2.19.7 的 release 产物；在重新打包前，此校验会因版本不一致而正确失败。
该流程不证明二进制必然来自指定提交，发布者仍需确认它是该标签代码的干净构建，并做安装验证。

### 8.2 上传草稿

准备指向当前 HEAD 的 `v<version>` 标签并人工推送至 `github` remote，
确认 GitHub CLI 已登录，然后直接传入一段更新说明：

```powershell
npm run desktop:release -- "修复安装包命名问题，优化播放体验"
```

文案请按实际改动填写，并用引号包裹。此命令只创建草稿，不会直接公开发布。
仍兼容旧用法：`npm run desktop:release -- --upload-draft <更新说明文件>`。

脚本会：

1. 重新校验本地产物，要求工作树干净。
2. 验证本地标签指向当前 HEAD，标签中的 package.json 版本一致。
3. 使用 `--repo cqmyg1039/Flow-LibreTV`，核对远端标签对象与本地一致。
4. 如已有该版本公开 Release 或草稿，停止，避免覆盖未知内容。
5. 创建 draft Release 后上传三件套，核对远端附件名称、数量、字节大小及上传完成状态。
6. 保持草稿，提示人工检查后再在 GitHub 上公开；脚本不会自动发布。

上传失败时草稿可能已存在，客户端看不到该草稿。人工检查/清理草稿后再重试，
不要为了重试删除已经公开的历史版本。

### 8.3 如果以后切换自建源

当前不实现运行时切换。未来变更 build.publish 后需要重新分发包含新源的客户端；
不能只修改仓库配置就让所有已安装客户端自动切源。

自建源必须先上传安装器和 blockmap 并验证可访问，**最后原子发布 latest.yml**，
避免用户先发现版本却拿不到安装包。需验证 HTTPS、Range、缓存策略和差分回退。

## 9. 验证清单

### 自动化（不运行构建）

```powershell
npm test -- src/lib/updater.test.ts src/lib/updater-store.test.ts src/lib/updater-journal.test.ts src/lib/release-artifacts.test.ts
npm run typecheck
npm run lint
```

测试覆盖重复操作、错误去重、安装前退出及超时、IPC 发送者、纯文本说明、旧快照竞争、
关闭提示后继续下载、桥接拒绝、版本不一致、SHA512 失败、blockmap 缺失及不安全路径、安装结果日志。

### 必须另行完成的 Windows 真机验收

- 全新 NSIS 安装存在 app-update.yml 和安装标记；win-unpacked 没有自动安装能力。
- 从带 updater 的旧安装版到更高版本：检查、稍后、下载、关闭提示、刷新、重启安装、重新打开。
- 相同版本、低版本、预发布不升级；后台错误不打断播放，手动错误可见。
- 下载断网后重试，观察实际缓存行为，不以“库支持缓存”替代续传验收。
- 验证旧安装器缓存存在/缺失、新旧 blockmap 缺失时的差分与全量行为。
- 安装时 standalone 已退出；安装取消、权限拒绝、磁盘不足后可手动恢复。
- 检查版本、历史、收藏、设置、固定端口及云端同步保持正确。
- 如签名，验证发布者校验、证书续期、SmartScreen/UAC 的实际表现。
- 确认 Release 无密钥、测试源、私有下载凭据或不应分发的环境配置。

本次实现不运行构建，不生成安装器，不推送标签，不创建草稿，不公开 Release；
通过单元测试和静态检查不等于已经通过真实 Windows 升级验收。
