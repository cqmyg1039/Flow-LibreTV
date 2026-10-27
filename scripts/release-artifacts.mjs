import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

// 复用 electron-updater 已声明的解析依赖，不新增开发依赖。
const require = createRequire(import.meta.url);
const updaterRequire = createRequire(require.resolve('electron-updater'));
const yaml = updaterRequire('js-yaml');
const semver = updaterRequire('semver');

/** 流式计算安装包校验值，避免整个安装器常驻内存。@param {string} file 安装包路径 */
async function hashFile(file) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('base64');
}

/** 只接受 release 根目录内的本地文件名，拒绝 URL、路径穿越和符号链接逃逸。@param {string} directory 产物目录 @param {string} name 文件名 */
async function resolveArtifact(directory, name) {
  if (
    typeof name !== 'string' ||
    !name ||
    /[\\/:?#%]/.test(name) ||
    name === '.' ||
    name === '..'
  ) {
    throw new Error('更新元数据包含不安全的产物路径');
  }
  const file = await realpath(path.join(directory, name));
  if (path.dirname(file).toLowerCase() !== directory.toLowerCase())
    throw new Error('产物超出 release 目录');
  if (!(await stat(file)).isFile()) throw new Error('更新产物不是文件');
  return file;
}

/** 校验版本、元数据和三件套，返回可上传清单。@param {string} root 仓库根目录 */
export async function validateRelease(root) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (!semver.valid(pkg.version) || semver.prerelease(pkg.version))
    throw new Error('仅支持稳定 semver 版本');
  const providers = Array.isArray(pkg.build?.publish) ? pkg.build.publish : [pkg.build?.publish];
  const provider = providers.find((item) => item?.provider === 'github');
  if (!provider || !/^[\w-]+$/.test(provider.owner) || !/^[\w.-]+$/.test(provider.repo)) {
    throw new Error('缺少合法的 GitHub 更新源配置');
  }
  const directory = await realpath(path.join(root, 'release'));
  const metadataFile = await resolveArtifact(directory, 'latest.yml');
  const info = yaml.load(await readFile(metadataFile, 'utf8'));
  if (info?.version !== pkg.version)
    throw new Error('latest.yml 与 package.json 版本不一致，请重新打包');
  if (!Array.isArray(info.files) || info.files.length !== 1)
    throw new Error('当前只支持单个 x64 NSIS 安装器');
  const entry = info.files[0];
  if (!entry?.url?.endsWith('.exe') || info.path !== entry.url || info.sha512 !== entry.sha512) {
    throw new Error('安装包路径或兼容元数据不一致');
  }
  const installer = await resolveArtifact(directory, entry.url);
  if ((await stat(installer)).size !== entry.size)
    throw new Error('安装包大小与 latest.yml 不一致');
  if ((await hashFile(installer)) !== entry.sha512) throw new Error('安装包 SHA512 校验失败');
  const blockmap = await resolveArtifact(directory, `${entry.url}.blockmap`);
  if (!(await stat(blockmap)).size) throw new Error('blockmap 为空');
  return {
    version: pkg.version,
    repo: `${provider.owner}/${provider.repo}`,
    files: [installer, blockmap, metadataFile],
  };
}
