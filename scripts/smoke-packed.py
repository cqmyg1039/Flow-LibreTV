"""验收辅助：用打包产物（release/win-unpacked/LibreTV.exe）在 ELECTRON_RUN_AS_NODE 模式下启动
standalone server 并请求 /api/status，验证 ABI 兼容与打包资源完整性。"""
import os
import subprocess
import sys
import time
import urllib.request

EXE = r"D:\zht\demo\LibreTV-main\release\win-unpacked\LibreTV.exe"
WORKDIR = r"D:\zht\demo\LibreTV-main\release\win-unpacked\resources\standalone"

env = dict(os.environ)
env["PORT"] = "8899"
env["HOSTNAME"] = "127.0.0.1"
env["ELECTRON_RUN_AS_NODE"] = "1"

proc = subprocess.Popen(
    [EXE, "server.js"],
    cwd=WORKDIR,
    env=env,
    stdout=open(r"D:\zht\demo\LibreTV-main\release\smoke-out.log", "wb"),
    stderr=open(r"D:\zht\demo\LibreTV-main\release\smoke-err.log", "wb"),
)
print(f"started pid={proc.pid}")
ok = False
for i in range(20):
    time.sleep(0.5)
    try:
        with urllib.request.urlopen("http://127.0.0.1:8899/api/status", timeout=3) as r:
            body = r.read(200).decode("utf-8", "replace")
            print(f"RESULT=HTTP {r.status} OK body={body[:80]}")
            ok = True
            break
    except Exception as e:
        time.sleep(0.5)
if not ok:
    print("RESULT=ERR server never became ready")
    # 打印子进程状态帮助排查
    print(f"proc.poll()={proc.poll()}")

proc.terminate()
try:
    proc.wait(timeout=5)
except Exception:
    proc.kill()
print("cleanup done")
sys.exit(0 if ok else 1)
