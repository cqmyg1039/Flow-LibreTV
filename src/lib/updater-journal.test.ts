import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createUpdateJournal } = require('../../electron/update-journal.js');
const TEMP_DIRS: string[] = [];

/** 每项测试使用独立日志目录，不接触真实 userData。@param 无参数 */
async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'libretv-journal-'));
  TEMP_DIRS.push(directory);
  const logger = { info: vi.fn(), error: vi.fn() };
  return {
    directory,
    logger,
    create: (currentVersion = '2.19.8') =>
      createUpdateJournal({ directory, logger, currentVersion }),
  };
}

afterEach(async () => {
  for (const directory of TEMP_DIRS.splice(0)) {
    const resolved = path.resolve(directory);
    if (
      path.dirname(resolved) !== path.resolve(tmpdir()) ||
      !path.basename(resolved).startsWith('libretv-journal-')
    ) {
      throw new Error('拒绝清理非测试目录');
    }
    await rm(resolved, { recursive: true, force: true });
  }
});

describe('安装结果日志', () => {
  it('没有历史安装意图则不提示', async () => {
    const { create } = await setup();
    expect(create().recover()).toBeNull();
  });

  it('安装取消后仍运行旧版本时提示，并消费日志避免每次启动重复提示', async () => {
    const { create } = await setup();
    create().record('2.19.9');
    expect(create().recover()).toContain('上次更新未完成');
    expect(create().recover()).toBeNull();
  });

  it('目标版本启动时只记录日志，不报告安装失败', async () => {
    const { create, logger } = await setup();
    create().record('2.19.9');
    expect(create('2.19.9').recover()).toBeNull();
    expect(logger.info).toHaveBeenCalledOnce();
  });

  it('日志损坏不阻止应用启动，记录诊断信息', async () => {
    const { create, directory, logger } = await setup();
    await writeFile(path.join(directory, 'last-update-attempt.json'), 'not-json');
    expect(create().recover()).toBeNull();
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('只保存源版本和目标版本，不写入凭据或安装路径', async () => {
    const { create, directory } = await setup();
    create().record('2.19.9');
    expect(
      JSON.parse(await readFile(path.join(directory, 'last-update-attempt.json'), 'utf8'))
    ).toEqual({
      fromVersion: '2.19.8',
      targetVersion: '2.19.9',
    });
  });
});
