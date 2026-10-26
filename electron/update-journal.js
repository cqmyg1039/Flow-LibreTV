'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** 保存安装意图，下次启动核对实际版本；不把拉起安装器当作成功。@param {object} options 应用路径、版本和日志 */
function createUpdateJournal({ directory, currentVersion, logger }) {
  const file = path.join(directory, 'last-update-attempt.json');
  return {
    record: (version) => {
      fs.writeFileSync(
        file,
        JSON.stringify({ fromVersion: currentVersion, targetVersion: version })
      );
    },
    recover: () => {
      if (!fs.existsSync(file)) return null;
      try {
        const attempt = JSON.parse(fs.readFileSync(file, 'utf8'));
        fs.unlinkSync(file);
        logger.info('[updater] last install attempt', attempt, 'running', currentVersion);
        if (attempt.fromVersion === currentVersion && attempt.targetVersion !== currentVersion) {
          return '上次更新未完成，当前仍为旧版本。请重试，或从 GitHub Releases 手动安装。';
        }
      } catch (error) {
        logger.error('[updater] cannot read install journal', error);
      }
      return null;
    },
  };
}

module.exports = { createUpdateJournal };
