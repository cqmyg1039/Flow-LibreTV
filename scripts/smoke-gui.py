"""验收辅助：以完整 GUI 模式启动打包产物 LibreTV.exe（主进程逻辑）：
启动 standalone server → 轮询就绪 → 打开 BrowserWindow。验证主进程链路可用。
验证后清理全部 LibreTV 相关进程并确认端口释放。"""
import os
import subprocess
import sys
import time
import urllib.request

EXE = r"D:\zht\demo\LibreTV-main\release\win-unpacked\LibreTV.exe"
LOG = r"D:\zht\demo\LibreTV-main\release\smoke-gui.log"

_log = open(LOG, "w", encoding="utf-8")
def out(msg):
    print(msg, flush=True)
    _log.write(msg + "\n")
    _log.flush()

proc = subprocess.Popen([EXE], cwd=os.path.dirname(EXE))
print(f"GUI started pid={proc.pid}", flush=True)

# 等待主进程把 server 拉起来（server 端口随机，从 netstat 反查监听端口）
time.sleep(10)
port = None
try:
    out = subprocess.run(
        ["netstat", "-ano"], capture_output=True, text=True, timeout=15
    ).stdout
    for line in out.splitlines():
        if "LISTENING" in line and line.split()[-1] == str(proc.pid):
            addr = line.split()[1]  # 127.0.0.1:port
            port = int(addr.rsplit(":", 1)[1])
            break
    print(f"listening port = {port}", flush=True)
    if port:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/status", timeout=5) as r:
            print(f"GUI-SMOKE=HTTP {r.status} OK", flush=True)
except Exception as e:
    print(f"GUI-SMOKE=ERR {e!r}", flush=True)

alive = proc.poll() is None
print(f"GUI process alive (window open) = {alive}", flush=True)

# 清理：结束所有 LibreTV 进程（含可能残留的 ELECTRON_RUN_AS_NODE server 子进程）
subprocess.run(
    ["taskkill", "/F", "/IM", "LibreTV.exe"], capture_output=True, text=True
)
time.sleep(2)
# 用 CSV 格式确认无残留
out = subprocess.run(
    ["tasklist", "/FI", "IMAGENAME eq LibreTV.exe", "/FO", "CSV"],
    capture_output=True, text=True, timeout=15,
).stdout
remaining = len([l for l in out.splitlines() if "LibreTV.exe" in l])
# 确认端口已释放（若还能连上说明残留）
port_gone = True
if port:
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{port}/api/status", timeout=2)
        port_gone = False
    except Exception:
        port_gone = True
print(f"after cleanup: LibreTV processes remaining = {remaining}, port released = {port_gone}", flush=True)

