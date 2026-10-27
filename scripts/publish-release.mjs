import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateRelease } from './release-artifacts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 不通过 shell 调用工具，防止参数被二次解释。@param {string} command 命令 @param {string[]} args 参数 */
function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0)
    throw new Error(result.error?.message || result.stderr || `${command} 失败`);
  return result.stdout.trim();
}

/** 验证工作树与本地标签，禁止自动创建指向未知提交的标签。@param {string} tag 版本标签 */
function verifyGit(tag) {
  if (run('git', ['status', '--porcelain']))
    throw new Error('工作树不干净，请先提交或移出无关修改');
  const head = run('git', ['rev-parse', 'HEAD']);
  const tagged = run('git', ['rev-parse', `${tag}^{commit}`]);
  if (head !== tagged) throw new Error(`${tag} 必须指向当前 HEAD`);
  const committed = JSON.parse(run('git', ['show', `${tag}:package.json`]));
  if (`v${committed.version}` !== tag) throw new Error('标签提交中的版本号不匹配');
}

/** 核验远端标签和草稿附件；公开 Release 一律不覆盖。@param {object} release 发布参数 @param {string} tag 标签 */
function verifyRemote(release, tag) {
  const ref = JSON.parse(run('gh', ['api', `repos/${release.repo}/git/ref/tags/${tag}`]));
  const localObject = run('git', ['rev-parse', tag]);
  if (ref.object.sha !== localObject) throw new Error('远端标签与本地标签不一致，请先推送正确标签');
  const result = JSON.parse(run('gh', ['api', `repos/${release.repo}/releases?per_page=100`]));
  const existing = result.find((item) => item.tag_name === tag);
  if (existing && !existing.draft) throw new Error('该版本已公开发布，禁止覆盖');
  if (existing) throw new Error('该版本草稿已存在，请人工检查后处理，避免覆盖未知附件');
}

/** 仅创建草稿，核验远端附件后提示人工发布；不自动公开版本。@param {object} release 发布参数 @param {string} notesFile 更新说明文件 */
function uploadDraft(release, notesFile) {
  const tag = `v${release.version}`;
  verifyGit(tag);
  verifyRemote(release, tag);
  run('gh', [
    'release',
    'create',
    tag,
    '--repo',
    release.repo,
    '--verify-tag',
    '--draft',
    '--title',
    `LibreTV ${release.version}`,
    '--notes-file',
    notesFile,
  ]);
  run('gh', ['release', 'upload', tag, '--repo', release.repo, ...release.files]);
  const assets = JSON.parse(
    run('gh', ['release', 'view', tag, '--repo', release.repo, '--json', 'assets'])
  ).assets;
  if (
    assets.length !== release.files.length ||
    !release.files.every((file) =>
      assets.some(
        (asset) =>
          asset.name === path.basename(file) &&
          asset.state === 'uploaded' &&
          asset.size === statSync(file).size
      )
    )
  ) {
    throw new Error('草稿附件校验失败，禁止公开发布');
  }
  return tag;
}

/** 默认本地验证；--upload-draft 才上传，始终保留人工发布确认。@param {string[]} args CLI 参数 */
async function main(args) {
  const upload = args[0] === '--upload-draft';
  if (args.length && (!upload || args.length !== 2))
    throw new Error('用法：npm run desktop:release [-- --upload-draft <更新说明文件>]');
  const release = await validateRelease(ROOT);
  console.log(`产物校验通过：${release.repo} v${release.version}`);
  if (!upload) return console.log('未上传。使用 --upload-draft <更新说明文件> 创建草稿。');
  const notesFile = path.resolve(ROOT, args[1]);
  if (!(await readFile(notesFile, 'utf8')).trim()) throw new Error('更新说明不能为空');
  const tag = uploadDraft(release, notesFile);
  console.log(`草稿 ${tag} 三件套已上传。请人工检查附件、提交及更新说明后，在 GitHub 上发布。`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
