# LibreTV 在 MacBook Pro 上的部署指南（免费 · Cloudflare Tunnel）

> 目标：把 LibreTV 跑在家里的 MacBook Pro 上，家人通过域名免 VPN 访问。
> 成本：0 元（MacBook 已有）+ 域名（eu.org 免费 或 .top/.xyz 首年 1-14 元）。
> 端口固定为 **8080**（项目 scripts 已写死）。

## 总体架构

```
家人浏览器 → 你的域名 → Cloudflare 节点 → 加密隧道(cloudflared) → MacBook :8080
```

前提条件：
- MacBook 安装好 macOS，能上网
- 已经有一个域名（eu.org 免费域名 / 或已买的 .top/.xyz/.com），并已托管到 Cloudflare（Add site，Free 计划）
- 域名还没就绪也没关系：先用第 1-7 步在 MacBook 本地跑起来，域名就绪后再做第 8 步

---

## 第 1 步：检查 / 安装 Node.js（LTS 20+）

打开 MacBook 的「终端」(Terminal)，输入：

```bash
node -v && npm -v
```

- 有输出且 Node ≥ 20 → 跳到第 2 步
- 没有 Node → 二选一：

方式 A（推荐，Homebrew）：
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node@22
echo 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
node -v   # 应显示 v22.x
```

方式 B（官网 pkg 安装）：打开 https://nodejs.org 下载 LTS 版 `.pkg`，双击安装。

---

## 第 2 步：拉取代码

```bash
git clone https://github.com/cqmyg1039/Flow-LibreTV.git ~/libretv
cd ~/libretv
```

> 注：仓库含片头片尾跳过 v2（进度条 OP/ED 标记、自动跳过、按钮智能显隐）。

## 第 3 步：写入配置 `.env`

```bash
cat > ~/libretv/.env <<'EOF'
# LibreTV 本地部署配置
# 必填：访问密码（访问站点时输入）
PASSWORD=libretv

# 预置点播源（已测试可用 2026-10-22，14 个源）
DEFAULT_SOURCES=[{"name":"360资源","url":"https://360zy.com/api.php/provide/vod"},{"name":"豆瓣资源","url":"https://dbzy.tv/api.php/provide/vod"},{"name":"电影天堂","url":"http://caiji.dyttzyapi.com/api.php/provide/vod"},{"name":"极速资源","url":"https://jszyapi.com/api.php/provide/vod"},{"name":"暴风资源","url":"https://bfzyapi.com/api.php/provide/vod"},{"name":"iqiyi资源","url":"https://www.iqiyizyapi.com/api.php/provide/vod"},{"name":"魔都资源","url":"https://www.mdzyapi.com/api.php/provide/vod"},{"name":"樱花资源","url":"https://m3u8.apiyhzy.com/api.php/provide/vod"},{"name":"非凡影视","url":"http://ffzy5.tv/api.php/provide/vod"},{"name":"百度云资源","url":"https://api.apibdzy.com/api.php/provide/vod"},{"name":"量子资源","url":"https://cj.lziapi.com/api.php/provide/vod"},{"name":"无尽资源","url":"https://api.wujinapi.me/api.php/provide/vod"},{"name":"最大资源","url":"https://api.zuidapi.com/api.php/provide/vod"},{"name":"天涯资源","url":"https://tyyszy.com/api.php/provide/vod"}]

# 可选：代理请求上游超时（毫秒）
REQUEST_TIMEOUT=8000

# 可选：最大重试次数
MAX_RETRIES=1
EOF
```

## 第 4 步：安装依赖（国内镜像，快）

```bash
cd ~/libretv
npm install --registry=https://registry.npmmirror.com
```

## 第 5 步：构建 + 启动

```bash
npm run build
npm start
```

看到类似 `Local: http://localhost:8080` 即成功。
**本机验证**：MacBook 上浏览器打开 http://localhost:8080 ，输入密码 `libretv`，能进首页即 OK。

## 第 6 步：开机自启（关掉终端也不停）

写一个 launchd 配置（自动替换为你的用户名）：

```bash
USERNAME=$(whoami)
cat > ~/Library/LaunchAgents/com.libretv.app.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.libretv.app</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd /Users/$USERNAME/libretv && npm start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>/Users/$USERNAME/libretv</string>
  <key>StandardOutPath</key><string>/tmp/libretv.log</string>
  <key>StandardErrorPath</key><string>/tmp/libretv.err</string>
</dict>
</plist>
EOF
launchctl unload ~/Library/LaunchAgents/com.libretv.app.plist 2>/dev/null
launchctl load ~/Library/LaunchAgents/com.libretv.app.plist
```

验证：`curl -s http://localhost:8080 -o /dev/null -w "%{http_code}"` 应返回 200。

## 第 7 步：防止睡眠（MacBook 必须常开）

```bash
# 插电时永不自动睡眠（需要输入开机密码授权）
sudo pmset -c sleep 0
# 显示器关闭不影响运行；合盖不休眠：
sudo pmset -c disablesleep 1
```

日常注意：
- 电源线**一直插着**
- 系统设置 → 电池 → 「阻止 Mac 自动进入睡眠」保持开启
- MacBook 正常使用办公不受影响（Node 进程占用极小）

---

## 第 8 步：Cloudflare Tunnel 暴露到公网（域名就绪后执行）

### 8.1 安装 cloudflared

```bash
brew install cloudflared
cloudflared --version   # 确认安装成功
```

### 8.2 登录 Cloudflare 账号（会弹出浏览器授权）

```bash
cloudflared tunnel login
```

### 8.3 创建隧道

```bash
cloudflared tunnel create libretv
# 会生成隧道 ID，形如 6e5f9b0a-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

### 8.4 绑定域名（把 tv.你的域名 换成你自己的）

```bash
cloudflared tunnel route dns libretv tv.你的域名.com
```

### 8.5 写隧道配置文件

```bash
TUNNEL_ID=$(cloudflared tunnel list | grep libretv | awk '{print $1}')
cat > ~/.cloudflared/config.yml <<EOF
tunnel: $TUNNEL_ID
credentials-file: /Users/$(whoami)/.cloudflared/$TUNNEL_ID.json

ingress:
  - hostname: tv.你的域名.com
    service: http://localhost:8080
  - service: http_status:404
EOF
```

### 8.6 启动隧道并验证

```bash
cloudflared tunnel run libretv
# 另开一个终端：curl -s https://tv.你的域名.com -o /dev/null -w "%{http_code}"
# 返回 200 即公网通了
```

### 8.7 隧道开机自启

```bash
brew services start cloudflared
```

---

## 完成后的家人访问

- 网址：`https://tv.你的域名.com`
- 密码：`libretv`
- 无需 VPN、无需备案、无需公网 IP

## 常见问题

| 现象 | 处理 |
|---|---|
| `npm install` 很慢/报错 | 确认命令带 `--registry=https://registry.npmmirror.com` |
| 8080 端口被占用 | `lsof -i :8080` 找到进程杀掉，或改 package.json 里的 `-p` 端口 |
| 家人访问超时 | 家里断网/断电了；查 MacBook 是否睡眠（`caffeinate -s` 保活）、cloudflared 是否在跑 |
| 重启后不自动恢复 | `launchctl list | grep libretv` 和 `brew services list | grep cloudflared` 确认两个服务都在 |
| 电视看不了 | 智能电视没有浏览器输入密码不方便，建议电视用 Vercel 站（已上线）或给电视配浏览器 |

## 双保险建议

- **MacBook 为主站**（快、免费、改代码立即生效）
- **Vercel 站 https://flow-libretv.vercel.app 保持在线**（断电/断网时家人还能用）
- 本地代码改动记得 `git push` 到 GitHub（remote `github`），Vercel 会自动同步构建
