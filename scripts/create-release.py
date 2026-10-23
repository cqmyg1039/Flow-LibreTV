"""发布 LibreTV 桌面版到 GitHub Releases（cqmyg1039/Flow-LibreTV）。

用法：GH_TOKEN 环境变量提供 GitHub PAT；默认上传 release/ 下最新 Setup + portable。
流程：创建 Release（tag 不存在时自动创建）→ 逐个上传 exe asset → 校验 assets 列表。
"""
import json
import os
import urllib.request

TOKEN = os.environ["GH_TOKEN"]
OWNER = "cqmyg1039"
REPO = "Flow-LibreTV"
VERSION = "2.19.7"
TAG = f"v{VERSION}"
NAME = f"LibreTV 桌面版 {VERSION}（Windows exe）"
BODY = (
    "LibreTV Windows 桌面版（Electron 壳 + 本地 Next standalone 服务）。\n\n"
    "- `LibreTV Setup 2.19.7.exe`：NSIS 安装包（可自选目录、桌面快捷方式）\n"
    "- `LibreTV-2.19.7-portable.exe`：免安装便携版，双击即用\n\n"
    "使用：双击运行，输入密码 `libretv`。首次运行 Windows Defender 若提示“未知发布者”，"
    "点“更多信息 → 仍要运行”。桌面版与网页版共享同一份观看历史（云端同步）。\n\n"
    "v2.19.7 桌面版：历史跨设备同步、片头片尾跳过、首页榜单文字封面卡（绕开豆瓣图床防盗链）。"
)
RELEASE_DIR = r"D:\zht\demo\LibreTV-main\release"
ASSETS = [
    ("LibreTV Setup 2.19.7.exe", "application/vnd.microsoft.portable-executable"),
    ("LibreTV-2.19.7-portable.exe", "application/vnd.microsoft.portable-executable"),
]

BASE = f"https://api.github.com/repos/{OWNER}/{REPO}"

def api(url, data=None, method=None, headers=None, binary=None):
    body = None
    h = {
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "libretv-release-script",
    }
    if binary is not None:
        body = binary
        h.update({"Content-Type": headers or "application/octet-stream"})
    elif data is not None:
        body = json.dumps(data).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=h, method=method or ("POST" if data is not None or binary is not None else "GET"))
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        print(f"API ERR {e.code}: {raw[:300]}")
        return e.code, None

# 1. 创建 Release（tag 不存在会自动创建）
status, rel = api(f"{BASE}/releases", {"tag_name": TAG, "name": NAME, "body": BODY, "draft": False, "prerelease": False})
if status not in (200, 201):
    # 可能已存在，查询
    status2, rel = api(f"{BASE}/releases/tags/{TAG}")
    if status2 != 200:
        print("无法创建或找到 Release，退出")
        raise SystemExit(1)
    print(f"Release 已存在: {rel['html_url']}")
else:
    print(f"Release 创建成功: {rel['html_url']}")
release_id = rel["id"]

# 2. 上传 exe assets
for fname, ctype in ASSETS:
    fpath = os.path.join(RELEASE_DIR, fname)
    if not os.path.exists(fpath):
        print(f"跳过（不存在）: {fname}")
        continue
    size = os.path.getsize(fpath)
    print(f"上传 {fname}（{size/1024/1024:.1f} MB）...", flush=True)
    # asset 上传走 uploads.github.com（api.github.com 的 assets 端点会 404）
    with open(fpath, "rb") as f:
        st, asset = api(
            f"https://uploads.github.com/repos/{OWNER}/{REPO}/releases/{release_id}/assets?name={urllib.request.quote(fname)}",
            binary=f.read(),
            headers=ctype,
        )
    if st in (200, 201):
        print(f"  上传成功: {asset['browser_download_url']}")
    else:
        print(f"  上传失败 status={st}")

# 3. 校验
status, rel = api(f"{BASE}/releases/{release_id}")
if rel:
    print(f"\n最终 Release: {rel['html_url']}")
    for a in rel.get("assets", []):
        print(f"  - {a['name']}  ({a['size']/1024/1024:.1f} MB) {a['browser_download_url']}")
