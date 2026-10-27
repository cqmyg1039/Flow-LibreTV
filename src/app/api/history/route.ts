import { NextRequest, NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import type { HistoryEntry, ProgressEntry } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 观看历史跨设备同步 API。
 * - GET  全量拉取 { history[], progress[] }（供 syncPull 合并）
 * - POST upsert 批量历史 + 批量删除 + 清空（body 三字段任意组合）
 * - DELETE 单条删除（?id=）或清空（?all=1）
 * 鉴权复用 api-guard（密码 cookie）；未配置 POSTGRES_URL 时返回 503，前端据此禁用同步。
 *
 * @vercel/postgres 在模块顶层实例化时会校验连接串，缺少 POSTGRES_URL 直接抛错，
 * 会拖垮本地开发与无数据库的构建，因此这里一律在检测到环境变量后才动态加载。
 */

let ensured = false;

async function ensureTables(): Promise<void> {
  if (ensured) return;
  const { sql } = await import('@vercel/postgres');
  await sql`create table if not exists watch_history (
    id text primary key,
    source_key text not null,
    source_url text,
    vod_id text not null,
    title text not null,
    pic text,
    episode_index int not null default 0,
    total_episodes int not null default 0,
    playback_position int not null default 0,
    duration int not null default 0,
    device_id text not null default 'shared',
    ts bigint not null
  )`;
  await sql`create table if not exists watch_progress (
    key text primary key,
    position int not null default 0,
    duration int not null default 0,
    updated_at bigint not null
  )`;
  ensured = true;
}

const HISTORY_SELECT = `
  select id, source_key as "sourceKey", source_url as "sourceUrl", vod_id as "vodId",
         title, pic, episode_index as "episodeIndex", total_episodes as "totalEpisodes",
         playback_position as "playbackPosition", duration, ts as "timestamp"
  from watch_history
  order by ts desc
  limit 100
`;

const PROGRESS_SELECT = `
  select key, position, duration, updated_at as "updatedAt"
  from watch_progress
  order by updated_at desc
  limit 5000
`;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const guard = guardRequest(req);
  if (guard) return guard;
  if (!process.env.POSTGRES_URL) return noDbResponse();
  try {
    const { sql } = await import('@vercel/postgres');
    await ensureTables();
    const [historyRows, progressRows] = await Promise.all([
      sql.query(HISTORY_SELECT),
      sql.query(PROGRESS_SELECT),
    ]);
    return NextResponse.json({
      history: historyRows.rows as unknown as HistoryEntry[],
      progress: progressRows.rows as unknown as ProgressEntry[],
    });
  } catch (err) {
    return dbError(err);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = guardRequest(req);
  if (guard) return guard;
  let body: {
    history?: HistoryEntry[];
    deleteHistory?: string[];
    clearAll?: boolean;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError('请求体不是合法 JSON', 400);
  }
  if (!process.env.POSTGRES_URL) return noDbResponse();
  try {
    const { sql } = await import('@vercel/postgres');
    await ensureTables();

    if (body.clearAll) {
      await sql`delete from watch_history`;
      await sql`delete from watch_progress`;
      return NextResponse.json({ ok: true });
    }

    if (body.deleteHistory && body.deleteHistory.length > 0) {
      for (const id of body.deleteHistory) {
        await sql`delete from watch_history where id = ${id}`;
      }
    }

    if (body.history && body.history.length > 0) {
      for (const h of body.history) {
        await sql`insert into watch_history
          (id, source_key, source_url, vod_id, title, pic, episode_index, total_episodes, playback_position, duration, ts)
          values (${h.id}, ${h.sourceKey}, ${h.sourceUrl ?? null}, ${h.vodId}, ${h.title}, ${h.pic ?? null},
                  ${Math.round(h.episodeIndex)}, ${Math.round(h.totalEpisodes)}, ${Math.round(h.playbackPosition)}, ${Math.round(h.duration)}, ${h.timestamp})
          on conflict (id) do update set
            source_key = excluded.source_key,
            source_url = excluded.source_url,
            vod_id = excluded.vod_id,
            title = excluded.title,
            pic = excluded.pic,
            episode_index = excluded.episode_index,
            total_episodes = excluded.total_episodes,
            playback_position = excluded.playback_position,
            duration = excluded.duration,
            ts = excluded.ts`;
      }
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return dbError(err);
  }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const guard = guardRequest(req);
  if (guard) return guard;
  const params = req.nextUrl.searchParams;
  if (!process.env.POSTGRES_URL) return noDbResponse();
  try {
    const { sql } = await import('@vercel/postgres');
    await ensureTables();
    if (params.get('all') === '1') {
      await sql`delete from watch_history`;
      await sql`delete from watch_progress`;
      return NextResponse.json({ ok: true });
    }
    const id = params.get('id');
    if (!id) return jsonError('缺少 id 参数', 400);
    await sql`delete from watch_history where id = ${id}`;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return dbError(err);
  }
}

function noDbResponse(): NextResponse {
  return NextResponse.json({ error: '未配置数据库（POSTGRES_URL）', syncEnabled: false }, { status: 503 });
}

function dbError(err: unknown): NextResponse {
  if (!process.env.POSTGRES_URL) return noDbResponse();
  console.error('history API error:', err);
  return NextResponse.json({ error: '数据库操作失败' }, { status: 500 });
}
