import { NextRequest, NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import type { ProgressEntry } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 播放进度（按集）跨设备同步 API。
 * - POST  upsert 批量进度 + 批量删除（body: { progress?, deleteProgress? }）
 * - DELETE 单条删除（?key=）
 * 表结构懒创建，与 /api/history 共用 watch_progress 表。
 * @vercel/postgres 动态加载，未配置 POSTGRES_URL 时返回 503（前端据此禁用同步）。
 */

let ensured = false;

async function ensureTables(): Promise<void> {
  if (ensured) return;
  const { sql } = await import('@vercel/postgres');
  await sql`create table if not exists watch_progress (
    key text primary key,
    position int not null default 0,
    duration int not null default 0,
    updated_at bigint not null
  )`;
  ensured = true;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = guardRequest(req);
  if (guard) return guard;
  let body: { progress?: ProgressEntry[]; deleteProgress?: string[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError('请求体不是合法 JSON', 400);
  }
  if (!process.env.POSTGRES_URL) return noDbResponse();
  try {
    const { sql } = await import('@vercel/postgres');
    await ensureTables();

    if (body.deleteProgress && body.deleteProgress.length > 0) {
      for (const key of body.deleteProgress) {
        await sql`delete from watch_progress where key = ${key}`;
      }
    }

    if (body.progress && body.progress.length > 0) {
      for (const p of body.progress) {
        await sql`insert into watch_progress
          (key, position, duration, updated_at)
          values (${p.key}, ${p.position}, ${p.duration}, ${p.updatedAt})
          on conflict (key) do update set
            position = excluded.position,
            duration = excluded.duration,
            updated_at = excluded.updated_at`;
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
  const key = req.nextUrl.searchParams.get('key');
  if (!key) return jsonError('缺少 key 参数', 400);
  if (!process.env.POSTGRES_URL) return noDbResponse();
  try {
    const { sql } = await import('@vercel/postgres');
    await ensureTables();
    await sql`delete from watch_progress where key = ${key}`;
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
  console.error('progress API error:', err);
  return NextResponse.json({ error: '数据库操作失败' }, { status: 500 });
}
