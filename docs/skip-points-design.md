# 片头片尾跳过（OP/ED Skip）功能设计

> 状态：v1 已实现并上线；v2 优化已实现（2026-10-23）
> 目标版本：LibreTV v2.19.7（Next.js 15 + TypeScript + ArtPlayer + hls.js + Dexie）
> 决策记录见文末「已确认决策」。

## 1. 功能定位

在 LibreTV 播放页新增「片头片尾跳过」能力，解决看剧时每集重复的片头曲（OP）与片尾曲（ED）需要手动拖进度的问题。

交付三个能力：

| 能力 | 说明 |
| --- | --- |
| 自动跳过 | 播放**自然经过**片头结束点 → 自动 seek 到正片；到达片尾开始点 → 按连播设置处理（连播开 → 提前切下一集；连播关 → 顶部提示，不打断播放） |
| 手动按钮 | 播放器控制栏新增「跳过片头 / 跳过片尾」按钮，单击即跳，**不受全局开关影响** |
| 记忆复用 | OP/ED 时间点按 `sourceKey + vodId`（整部剧）记录一次，全剧集共享生效 |

## 2. 数据模型

### 2.1 IndexedDB 新增表（`src/lib/db.ts`，v4）

```ts
export interface SkipPointEntry {
  id: string;          // `${sourceKey}_${vodId}`（整剧共享条目）
  sourceKey: string;   // 采集站标识
  vodId: string;       // 影片 id
  episodeIndex?: number; // 预留：每集独立标记（本期不做，字段保留）
  opEnd: number;       // 片头结束秒，0 = 未设置
  edStart: number;     // 片尾开始秒，0 = 未设置
  updatedAt: number;
}

db.version(4).stores({ skipPoints: 'id, sourceKey' });
```

读取优先级：`episodeIndex` 精确条目 → 整剧共享条目 → `null`。
查询量级：每剧至多 1 条（+ 少量例外集），性能无压力。

### 2.2 导出导入兼容

`exportConfig` 的 `data` 里追加 `skipPoints`（JSON 字符串）；`importConfig` 读取并 `bulkPut`，缺失时跳过（兼容旧配置）。

## 3. 全局设置（`src/lib/store.ts` AppSettings）

```ts
skipOp: boolean;   // 自动跳过片头，默认 false
skipEd: boolean;   // 自动跳过片尾，默认 false
```

- 默认**关闭**：避免误伤（用户可能故意看片头）；控制栏按钮不受开关限制。
- 持久化：`partialize` 加入两项即可。zustand persist 默认浅合并 `{...current, ...persisted}`，旧存量数据缺失字段自动取 current 默认值，**无需改 migrate 版本号**。

## 4. 核心机制：防误伤的自动跳过判定

### 4.1 判定规则（`player-shell.tsx` `video:timeupdate`）

维护 `lastPlaybackTimeRef`，**只在单调前进（cur > prev）时判定**，用户拖拽 / 回看永不触发自动跳转：

```ts
const cur = art.currentTime;
const prev = lastPlaybackTimeRef.current;
if (cur > prev) {
  // 片头：刚跨过 opEnd（prev < opEnd ≤ cur）
  if (skipOp && opEnd > 0 && prev < opEnd && cur >= opEnd) {
    lastPlaybackTimeRef.current = opEnd;      // 防 seek 引发的重入
    art.currentTime = opEnd;
    showHint('已跳过片头');
  }
  // 片尾：刚跨过 edStart（只触发一次，避免连播关时循环回调）
  else if (skipEd && edStart > 0 && prev < edStart && cur >= edStart && duration - cur > 5) {
    lastPlaybackTimeRef.current = cur;
    onSkipEd?.();                              // 父层决定行为
  }
}
lastPlaybackTimeRef.current = cur;
```

- **片头用「跨过」判定**：`prev < opEnd <= cur`，一次跳转，不重复。
- **片尾也用「跨过」判定**：每次播放只触发一次 `onSkipEd`，连播关闭时不会死循环。
- **seek 后立即重置基准**：跳完立刻把 `lastPlaybackTimeRef` 置为 `opEnd`，消除 seek 引发的下一次 timeupdate 重判。
- **换集（loadEpisode）重置基准**：`lastPlaybackTimeRef = 0`，避免沿用上一集的旧时间戳。

### 4.2 与进度恢复的关系（`restoreAndStart`）

恢复播放位置 `saved` 若落在片头区间内（`0 < saved < opEnd`），说明上次退出在片头里，恢复后立即追加一次「已跳过片头」的跳转；`saved >= opEnd` 则不动。

### 4.3 片尾行为语义（`watch/page.tsx` onSkipEd）

| 场景 | 行为 |
| --- | --- |
| 连播开 + 有下一集 | 清掉 autoNextTimer，直接 `goEpisode(next)`（比等 ended 的 800ms 更快） |
| 连播关 / 无下一集 | 不打断播放（尊重用户：没开连播时不自作主张跳结局），播放器已有顶部提示 |

## 5. 模块落点

| 文件 | 改动 |
| --- | --- |
| `src/lib/db.ts` | `SkipPointEntry` + v4 表 + `skipPointIdOf / getSkipPoints / saveSkipPoints / deleteSkipPoints` + 导出导入并入 |
| `src/lib/skip-points.ts`（新） | 纯函数：`normalizeSkipPoints`（边界归一化）、`shouldSkipOp`、`shouldTriggerEd`、`isInOpRange`；配套 vitest 单测 |
| `src/lib/store.ts` | AppSettings 加 `skipOp / skipEd`（默认 false）+ partialize 加入 |
| `src/components/player-shell.tsx` | 判定逻辑、控制栏「跳过片头/片尾」按钮（沿用 controls 机制，按是否有标记控制显隐）、快捷键、新 props |
| `src/app/watch/page.tsx` | 读取 skipPoints 注入、`onSkipEd` 提前切集、`onMarkSkipPoint` 写库 |
| `src/components/source-manager.tsx` | `PlaybackPanel` 增加两个开关（ToggleRow） |

**架构原则**：播放器保持无状态——skipPoints 由 watch 页读取后以 props 注入（与现有 `getRestorePosition` 模式一致），IndexedDB 读写不进 PlayerShell。

## 6. PlayerShell 新增 Props

```ts
skipOp?: boolean;                        // 自动跳过片头开关
skipEd?: boolean;                        // 自动跳过片尾开关
opEnd?: number;                          // 当前剧集生效的片头结束秒（0 = 无标记）
edStart?: number;                        // 当前剧集生效的片尾开始秒（0 = 无标记）
onSkipEd?: () => void;                   // 检测到片尾开始点，父层处理
onMarkSkipPoint?: (type: 'op' | 'ed', time: number) => void; // 标记当前位置
```

## 7. UI 与交互

### 7.1 控制栏按钮

- 「跳过片头」：有 `opEnd` 标记时显示，点击 `seek(opEnd)` + 提示
- 「跳过片尾」：有 `edStart` 标记时显示，点击调用 `onSkipEd`（连播开直接切集；连播关播到最后自然结束）

显隐通过现有 `controls.update({ name, style: { display } })` 机制（与 prev/next-episode 禁用态同套 API）。

### 7.2 标记入口

| 入口 | 行为 |
| --- | --- |
| 快捷键 `T` | 标记当前位置为片头结束点（写整剧条目 opEnd） |
| 快捷键 `Y` | 标记当前位置为片尾开始点（写整剧条目 edStart） |
| 快捷键 `H` | 手动跳到片头结束点（有标记时） |

标记写入后同页立即生效（watch 页 setState 刷新注入值）。

### 7.3 设置页（PlaybackPanel）

两个 `ToggleRow`：`自动跳过片头` / `自动跳过片尾`，挂 `store.updateSettings`。

## 8. 边界与容错

| 场景 | 处理 |
| --- | --- |
| 直播流 / duration 未知 | 整套判定不启用（无有效时长） |
| 总时长 < 90s | 忽略标记（短视频防误跳） |
| `opEnd` > 总时长 60% | 归一化为 0（视为无效标记） |
| `edStart` 距 ended < 5s | 视为自然结束，交给现有自动连播 |
| 换集 | 重置 `lastPlaybackTimeRef`，watch 页重读 skipPoints |
| 换源 / 换剧 | key 自然隔离（id 含 sourceKey + vodId） |

## 9. 二期可扩展（本期不做）

- OP/ED 区间化（前情提要 + OP 一体跳、ED 后彩蛋跳过）
- 每集独立标记（`episodeIndex` 字段已预留）
- 自动识别（跨集音频指纹比对定位 OP/ED）
- 进度条上绘制标记刻度（ArtPlayer 自定义 layer）
- skipPoints 云端同步

## 10. 已确认决策

| # | 决策点 | 结论 |
| --- | --- | --- |
| 1 | 片尾行为（连播开） | 到 ED 起点提前切下一集（不等 ended 的 800ms） |
| 2 | 片尾行为（连播关） | 不打断播放，仅顶部提示 |
| 3 | 全局开关默认值 | v1：默认 false；**v2：改为默认开启**——仅对「已标记」剧集生效，未标记剧完全不受影响，家人使用开箱即得（见 §11.3） |
| 4 | 标记粒度 | 整部剧共享一套（每集独立留待二期） |
| 5 | 自动跳转前提 | 仅单调前进（自然播放）触发，拖拽/回看永不误跳 |

## 11. v2 优化（进度条标记 + 按钮智能显隐 + 默认开启）

### 11.1 进度条区间标记

新增一个渲染进 ArtPlayer 进度条容器（`position: 'top'` 控件挂载到 `.art-control-progress`）的纯视觉控件 `skip-marks`：

- **OP 区间**：`[0, opEnd)` 绿色半透明色块（`rgba(34,197,94,0.5)`），右缘带 1.5px 白色边界线
- **ED 区间**：`[edStart, duration)` 红色半透明色块（`rgba(239,68,68,0.45)`），左缘带 1.5px 白色边界线
- 容器 `pointer-events: none`，不拦截进度条拖拽 / 点击
- 定位由 `renderSkipMarks(duration)` 按 `opEnd/duration`、`edStart/duration` 计算百分比；参数指纹（`opEnd|edStart|duration`）不变时跳过 DOM 写入，避免 timeupdate 高频空转
- duration 就绪前（元数据未加载）不渲染，`[opEnd, edStart, url]` effect 与 timeupdate 双入口兜底

### 11.2 手动按钮智能显隐

v1 按「有标记即常驻显示」两个按钮，视觉冗余。v2 改为**仅停留在对应区间时出现**：

| 播放位置 | 显示 |
| --- | --- |
| `0 < cur < opEnd`（正在播片头） | 「跳过片头」按钮 |
| `cur >= edStart` 且距结尾 > 5s（片尾区） | 「跳过片尾」按钮 |
| 正片区间 / 无标记 / 短视频 | 两个按钮均隐藏 |

判定复用纯函数 `skipZoneOf(opEnd, edStart, cur, duration): 'op' | 'ed' | null`（归一化后判断），按钮显隐在**区间切换时**才调用 `controls.update`（`lastSkipZoneRef` 去重）。自动跳过开启时自然播放会直接跳走，按钮只在暂停 / 拖回 / 关闭自动跳等场景作为兜底出现。

### 11.3 自动跳过默认开启

`skipOp` / `skipEd` 默认值由 `false` 改为 `true`。安全性依据：判定依赖 `normalizeSkipPoints` 归一化，**未标记（0）或非法标记一律不触发**；短视频（<90s）整体禁用。即默认开启只影响「主动标记过的剧集」，家人使用无需进设置。

### 11.4 v2 落点

| 文件 | 改动 |
| --- | --- |
| `src/lib/skip-points.ts` | 新增 `skipZoneOf` + `SkipZone` 类型 |
| `src/lib/skip-points.test.ts` | 新增 5 项单测（片头区 / 片尾区 / 正片 / 片尾尾差 <5s / 非法标记） |
| `src/components/player-shell.tsx` | `skip-marks` 进度条控件、`renderSkipMarks`、`updateSkipButtons`、`updateSkipUI`（timeupdate 驱动）、按钮显隐 effect 改造 |
| `src/lib/store.ts` | `skipOp` / `skipEd` 默认 `true` |
| `src/components/source-manager.tsx` | 开关描述补充进度条颜色提示 |
| `src/app/watch/page.tsx` | 快捷键提示补充「片头绿 / 片尾红显示在进度条」 |
