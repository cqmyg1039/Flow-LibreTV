"""兼容旧入口：委托安全发布脚本，默认只校验，传入文案才上传草稿，兼容 --upload-draft 文件参数。"""

import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

if __name__ == "__main__":
    result = subprocess.run(
        ["node", str(ROOT / "scripts" / "publish-release.mjs"), *sys.argv[1:]],
        cwd=ROOT,
        check=False,
    )
    raise SystemExit(result.returncode)
