"""生成 LibreTV 桌面版图标 build/icon.ico（多尺寸，含 256x256）。"""
import os
from PIL import Image, ImageDraw

BASE = 1024
R = 220  # 圆角半径（约 21.5%）
BG = (15, 17, 23, 255)        # #0f1117 深色底（与站点背景一致）
RING = (59, 130, 246, 255)    # #3b82f6 蓝色环
TRI = (255, 255, 255, 255)    # 白色播放三角

img = Image.new('RGBA', (BASE, BASE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 圆角背景
d.rounded_rectangle([0, 0, BASE - 1, BASE - 1], radius=R, fill=BG)

# 内圈蓝色圆角边框（模拟"电视屏幕"）
M = 110
d.rounded_rectangle([M, M, BASE - 1 - M, BASE - 1 - M], radius=R - 90, outline=RING, width=44)

# 中央播放三角（左对齐留白，视觉居中）
cx, cy = BASE // 2, BASE // 2
hw, hh = 300, 360  # 半宽半高
d.polygon(
    [(cx - hw // 2, cy - hh), (cx - hw // 2, cy + hh), (cx + hw, cy)],
    fill=TRI,
)

# 输出多尺寸 ico
os.makedirs('build', exist_ok=True)
sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
img.save('build/icon.ico', format='ICO', sizes=sizes)
# 同时输出一份 256 PNG 便于预览/复用
img.save('build/icon.png', format='PNG')
print('build/icon.ico + build/icon.png generated')
