import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { validateRelease } from '../../scripts/release-artifacts.mjs';

const TEMP_DIRS: string[] = [];

/** 创建最小产物 fixture，不调用真实打包或发布。@param 无参数 */
async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'libretv-release-'));
  TEMP_DIRS.push(root);
  await mkdir(path.join(root, 'release'));
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      version: '2.19.8',
      build: { publish: [{ provider: 'github', owner: 'cqmyg1039', repo: 'Flow-LibreTV' }] },
    })
  );
  const file = 'LibreTV-Setup-2.19.8.exe';
  const bytes = Buffer.from('fake-installer');
  const sha512 = createHash('sha512').update(bytes).digest('base64');
  const metadata = {
    version: '2.19.8',
    files: [{ url: file, sha512, size: bytes.length }],
    path: file,
    sha512,
  };
  await writeFile(path.join(root, 'release', file), bytes);
  await writeFile(path.join(root, 'release', `${file}.blockmap`), 'fake-blockmap');
  const metadataFile = path.join(root, 'release', 'latest.yml');
  await writeFile(metadataFile, JSON.stringify(metadata));
  return { root, file, metadata, metadataFile };
}

afterEach(async () => {
  // 仅删除本测试通过 mkdtemp 创建并登记的固定前缀目录。
  for (const directory of TEMP_DIRS.splice(0)) {
    const resolved = path.resolve(directory);
    if (
      path.dirname(resolved) !== path.resolve(tmpdir()) ||
      !path.basename(resolved).startsWith('libretv-release-')
    ) {
      throw new Error('拒绝清理非测试目录');
    }
    await rm(resolved, { recursive: true, force: true });
  }
});

describe('安全发布产物校验', () => {
  it('读取真实元数据文件名，返回匹配三件套与当前更新源', async () => {
    const { root, file } = await createFixture();
    const release = await validateRelease(root);
    expect(release.repo).toBe('cqmyg1039/Flow-LibreTV');
    expect(release.files.map((item: string) => path.basename(item))).toEqual([
      file,
      `${file}.blockmap`,
      'latest.yml',
    ]);
  });

  it('拒绝旧版 latest.yml', async () => {
    const { root, metadata, metadataFile } = await createFixture();
    await writeFile(metadataFile, JSON.stringify({ ...metadata, version: '2.19.7' }));
    await expect(validateRelease(root)).rejects.toThrow('版本不一致');
  });

  it('拒绝大小正确但内容被篡改的安装器', async () => {
    const { root, file } = await createFixture();
    await writeFile(path.join(root, 'release', file), 'FAKE-INSTALLER');
    await expect(validateRelease(root)).rejects.toThrow('SHA512');
  });

  it('拒绝缺失或空 blockmap', async () => {
    const { root, file } = await createFixture();
    await writeFile(path.join(root, 'release', `${file}.blockmap`), '');
    await expect(validateRelease(root)).rejects.toThrow('blockmap 为空');
  });

  it.each(['../outside.exe', 'https://example.com/setup.exe', '..\\outside.exe'])(
    '拒绝路径逃逸：%s',
    async (url) => {
      const { root, metadata, metadataFile } = await createFixture();
      metadata.files[0].url = url;
      metadata.path = url;
      await writeFile(metadataFile, JSON.stringify(metadata));
      await expect(validateRelease(root)).rejects.toThrow('不安全');
    }
  );

  it('拒绝预发布版本，避免污染稳定更新通道', async () => {
    const { root } = await createFixture();
    const pkgFile = path.join(root, 'package.json');
    const pkg = JSON.parse(await readFile(pkgFile, 'utf8'));
    await writeFile(pkgFile, JSON.stringify({ ...pkg, version: '2.19.8-beta.1' }));
    await expect(validateRelease(root)).rejects.toThrow('稳定');
  });
});
