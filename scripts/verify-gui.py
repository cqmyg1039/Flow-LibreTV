"""验收：GUI 版 LibreTV.exe 已由外部启动，本脚本反查 LibreTV.exe 进程的本地监听端口，
请求 /api/status 确认服务与页面链路可用；随后清理所有 LibreTV 进程并确认端口释放。"""
import subprocess
import time
import urllib.request

# 收集所有 LibreTV.exe PID
out = subprocess.run(
    ["tasklist", "/FI", "IMAGENAME eq LibreTV.exe", "/FO", "CSV"],
    capture_output=True, text=True, timeout=15,
).stdout
pids = set()
for line in out.splitlines():
    if "LibreTV.exe" in line:
        parts = line.split('","')
        if len(parts) >= 2:
            pid = parts[1].strip('"')
            if pid.isdigit():
                pids.add(pid)
print(f"LibreTV.exe pids = {sorted(pids)}", flush=True)

port = None
if pids:
    net = subprocess.run(["netstat", "-ano"], capture_output=True, text=True, timeout=15).stdout
    for line in net.splitlines():
        if "LISTENING" in line:
            parts = line.split()
            if len(parts) >= 5 and parts[-1] in pids:
                addr = parts[1]
                if addr.startswith("127.0.0.1:"):
                    port = int(addr.rsplit(":", 1)[1])
                    break
    print(f"server listening port = {port}", flush=True)
    if port:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/status", timeout=5) as r:
                print(f"GUI-SMOKE=HTTP {r.status} OK", flush=True)
        except Exception as e:
            print(f"GUI-SMOKE=ERR {e!r}", flush=True)

# 清理所有 LibreTV 进程
subprocess.run(["taskkill", "/F", "/IM", "LibreTV.exe"], capture_output=True, text=True)
time.sleep(2)
out2 = subprocess.run(
    ["tasklist", "/FI", "IMAGENAME eq LibreTV.exe", "/FO", "CSV"],
    capture_output=True, text=True, timeout=15,
).stdout
remaining = len([l for l in out2.splitlines() if "LibreTV.exe" in l])
port_gone = True
if port:
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{port}/api/status", timeout=2)
        port_gone = False
    except Exception:
        port_gone = True
print(f"after cleanup: remaining={remaining}, port_released={port_gone}", flush=True)
