# 观看历史跨设备同步 设计方案（v1）

> 目标：同一站点在不同设备（手机/平板/电脑）打开，都能看到同一份观看历史，
> 并且每部剧显示"上次看到的时间点"，点开自动从该进度继续播放。
> 兼容现有 Vercel 部署与未来 MacBook 部署。

## 1. 现状（已读代码核实）

| 数据 | 存储 | 说明 |
|---|---|---|
| 观看历史 `history` | IndexedDB `libretv.history` | 主键 `${sourceKey}_${vodId}`，含 playbackPosition/duration/episodeIndex/totalEpisodes/timestamp |
| 播放进度 `progress` | IndexedDB `libretv.progress` | 主键 `${sourceKey}_${vodId}_${episodeIndex}`，position/duration/updatedAt |
| 历史面板 | `history-panel.tsx` | 已显示"第 x 集 · 看到 12:34 · 相对时间 + 进度条" |
| 播放恢复 | watch 页 | 进入播放页读取 progress 按集恢复进度 |

**结论：单设备体验已完整；唯一缺口 = 数据不出浏览器 → 换设备丢失。**

## 2. 方案选型

- 云端存储选 **Vercel Postgres（Hobby 免费档）**：用用户**已有的 Vercel 账号**，无需任何新注册；
  免费额度（2026-10 核实）：256MB 存储 + 60 compute 小时/月，数据量几百 KB 绰绰有余。
- API route 与数据库同在 Vercel 环境内，访问最快；将来 MacBook 部署时 `.env` 加同一条 `POSTGRES_URL` 即互通。
- 不引入用户系统：站点本就单密码（`libretv`）家庭共用，历史记录按**全家共享一份**设计；
  云端表预留 `device_id` 字段，未来要按设备隔离可平滑升级。
- 现有 IndexedDB 保留为主存储（即时响应、离线可用、改动最小）；云端作为**同步镜像**。
- 备选：Supabase 免费版（需新注册账号，500MB）——仅在用户想把数据完全独立于 Vercel 时考虑。

## 3. 数据模型（Postgres，API 首次调用时懒建表，无需手动跑 SQL）

```sql
-- 观看历史（镜像 IndexedDB history 表）
create table if not exists watch_history (
  id text primary key,              -- `${sourceKey}_${vodId}`
  source_key text not null,
  source_url text,
  vod_id text not null,
  title text not null,
  pic text,
  episode_index int not null default 0,
  total_episodes int not null default 0,
  playback_position int not null default 0,
  duration int not null default 0,
  device_id text not null default 'shared',   -- 预留
  ts bigint not null
);

-- 播放进度（镜像 IndexedDB progress 表，按集；key 含来源/剧/集信息）
create table if not exists watch_progress (
  key text primary key,             -- `${sourceKey}_${vodId}_${episodeIndex}`
  position int not null default 0,
  duration int not null default 0,
  updated_at bigint not null
);
```

## 4. API 设计（Next.js App Router，全部复用现有密码鉴权 api-guard）

| 端点 | 方法 | 用途 |
|---|---|---|
| `/api/history` | GET | 全量拉取 { history[], progress[] }（≤100 条 + 进度表，几百 KB，可接受） |
| `/api/history` | POST | upsert 单条历史（body = HistoryEntry） |
| `/api/history` | DELETE | 删除单条（`id=`）或清空（`all=1`） |
| `/api/progress` | POST | upsert 单条进度（节流上报用，body = ProgressEntry） |

鉴权：复用 `src/lib/api-guard.ts` 的 cookie 校验，未登录返回 401。

## 5. 前端同步层（新增 `src/lib/history-sync.ts`）

```
写入本地 IndexedDB（现有逻辑不动）
   │  upsertHistory / saveProgress 之后
   ▼
标记 pending → 2s 防抖批量推送 → POST /api/history 或 /api/progress
   │
   ▼（应用启动 / 打开历史面板 / 进入播放页 时）
syncPull(): GET /api/history → 按时间戳合并到本地
```

合并规则（可单测的纯函数）：
- **history**：比较 `timestamp`，新者胜；本地仍处于 pending（未推送成功）的条目以本地为准
- **progress**：比较 `updatedAt`，新者胜
- 先 pull 后 push pending，避免互相覆盖
- 推送失败（断网/401）→ 保留 pending，下次启动重试，不阻塞本地使用

## 6. 播放续播体验（换设备后）

1. 进入播放页 → `syncPull()`（或直接用已同步的本地数据）→ 读取该集 progress
2. 若 `position > 10s` 且 `< duration × 0.95` → 播放器 seek 到该点 + 浮层提示
   「上次看到 12:34，已为你续播」（可点"从头播放"）
3. 播放中按现有 saveProgress 节流（10s 一次 + pause/unload 时刷新）→ 自动推云端
4. 历史面板展示「第 x 集 · 看到 12:34/45:00 + 进度条」——跨设备一致

## 7. 环境变量与部署

| 变量 | 来源 | 用途 |
|---|---|---|
| `POSTGRES_URL` | Vercel 控制台 Storage → Postgres 创建后自动生成 | 数据库连接串（服务端 API route 使用，**绝不暴露到浏览器**） |

- Vercel：Storage 创建 Postgres（选 Hobby）→ 连接串填到项目 Environment Variables（Production）→ 部署即生效；**建表无需手动操作**（API 首次调用自动 `CREATE TABLE IF NOT EXISTS`）
- MacBook（将来）：`.env` 追加 `POSTGRES_URL=` 同值即可
- 本地开发不配 `POSTGRES_URL`：API 返回 503，前端自动禁用同步，不影响本地使用与构建

## 8. 成本与依赖

- 0 元：Vercel Postgres Hobby（256MB / 60 compute 小时每月）在现有 Vercel 免费额度内；无新增第三方注册
- 新增依赖：`@vercel/postgres`（唯一）
- 用户一次性操作：Vercel 控制台建 Postgres + 环境变量填连接串（约 3 分钟）

## 9. 验收标准

1. 设备 A 看完《狂飙》第 5 集到 12:34，关掉；设备 B 打开 → 历史列表出现该记录且显示「第 5 集 · 看到 12:34」
2. 设备 B 点开该剧 → 自动从 12:34 续播，有提示，可"从头播放"
3. 设备 B 继续看到 20:00 退出 → 设备 A 刷新后历史/进度为 20:00（双向同步）
4. 删除单条历史/清空历史 → 云端同步删除
5. 断网时本地一切可用，恢复网络后自动补推
6. 未登录访问 API → 401；`typecheck`、`npm test`、`npm run build` 全绿
