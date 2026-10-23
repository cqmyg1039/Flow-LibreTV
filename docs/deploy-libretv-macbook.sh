#!/bin/bash
# ============================================================
# LibreTV 一键部署脚本（macOS / MacBook）
# 用法：把本文件拷到 MacBook，终端执行：
#   chmod +x deploy-libretv-macbook.sh && ./deploy-libretv-macbook.sh
# 作用：装依赖 → 写 .env → 构建 → 开机自启
# 隧道暴露（Cloudflare Tunnel）见 docs/macbook-deploy.md 第 8 步
# ============================================================
set -e

APP_DIR="$HOME/libretv"
GIT_REPO="https://github.com/cqmyg1039/Flow-LibreTV.git"

echo "==> [1/6] 检查 Node.js"
if ! command -v node >/dev/null 2>&1; then
  echo "✗ 未安装 Node。请先执行："
  echo "  /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
  echo "  brew install node@22"
  echo "然后重新运行本脚本。"
  exit 1
fi
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 20 ]; then
  echo "✗ Node 版本过低（$(node -v)），需要 20+。请升级后重试。"
  exit 1
fi
echo "✓ Node $(node -v) / npm $(npm -v)"

echo "==> [2/6] 拉取代码"
if [ -d "$APP_DIR/.git" ]; then
  echo "   目录已存在，拉取最新代码..."
  cd "$APP_DIR"
  git pull
else
  git clone "$GIT_REPO" "$APP_DIR"
  cd "$APP_DIR"
fi

echo "==> [3/6] 写入 .env（密码 + 14 个点播源）"
cat > "$APP_DIR/.env" <<'ENVEOF'
# LibreTV 本地部署配置
# 必填：访问密码（访问站点时输入）
PASSWORD=libretv

# 预置点播源（已测试可用 2026-10-22，14 个源）
DEFAULT_SOURCES=[{"name":"360资源","url":"https://360zy.com/api.php/provide/vod"},{"name":"豆瓣资源","url":"https://dbzy.tv/api.php/provide/vod"},{"name":"电影天堂","url":"http://caiji.dyttzyapi.com/api.php/provide/vod"},{"name":"极速资源","url":"https://jszyapi.com/api.php/provide/vod"},{"name":"暴风资源","url":"https://bfzyapi.com/api.php/provide/vod"},{"name":"iqiyi资源","url":"https://www.iqiyizyapi.com/api.php/provide/vod"},{"name":"魔都资源","url":"https://www.mdzyapi.com/api.php/provide/vod"},{"name":"樱花资源","url":"https://m3u8.apiyhzy.com/api.php/provide/vod"},{"name":"非凡影视","url":"http://ffzy5.tv/api.php/provide/vod"},{"name":"百度云资源","url":"https://api.apibdzy.com/api.php/provide/vod"},{"name":"量子资源","url":"https://cj.lziapi.com/api.php/provide/vod"},{"name":"无尽资源","url":"https://api.wujinapi.me/api.php/provide/vod"},{"name":"最大资源","url":"https://api.zuidapi.com/api.php/provide/vod"},{"name":"天涯资源","url":"https://tyyszy.com/api.php/provide/vod"}]

# 可选：代理请求上游超时（毫秒）
REQUEST_TIMEOUT=8000

# 可选：最大重试次数
MAX_RETRIES=1
ENVEOF
echo "✓ .env 已写入"

echo "==> [4/6] 安装依赖（国内镜像）"
npm install --registry=https://registry.npmmirror.com

echo "==> [5/6] 构建"
npm run build

echo "==> [6/6] 配置开机自启（launchd）"
USERNAME=$(whoami)
cat > "$HOME/Library/LaunchAgents/com.libretv.app.plist" <<EOF
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
launchctl unload "$HOME/Library/LaunchAgents/com.libretv.app.plist" 2>/dev/null || true
launchctl load "$HOME/Library/LaunchAgents/com.libretv.app.plist"

echo ""
echo "=============================================="
echo "✅ 部署完成！"
echo "  本机验证：打开浏览器访问 http://localhost:8080"
echo "  密码：libretv"
echo ""
echo "  下一步（可选但建议）："
echo "  1) 防止睡眠：sudo pmset -c sleep 0 && sudo pmset -c disablesleep 1"
echo "  2) 暴露公网：按 docs/macbook-deploy.md 第 8 步配置 Cloudflare Tunnel"
echo "=============================================="
