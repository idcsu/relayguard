#!/usr/bin/env bash
set -euo pipefail

echo "正在检查前端安全引用..."

FOUND=0

# 新前端源码目录
SRC_DIRS=(
  "web/src"
)

# 构建产物目录（仅检查 CDN 和 HTML，不检查 minified JS 中的 prompt/confirm 误报）
DIST_DIRS=(
  "web/dist"
  "internal/panel/webdist"
)

# 旧前端目录（如存在则也检查）
if [ -d "frontend/src" ]; then
  SRC_DIRS+=("frontend/src")
fi

# 禁止常见 CDN / 远程字体 / 第三方统计脚本。
# 不再禁止所有 https://，避免 React/Vite 生产包里的文档链接误报。
for target in "${SRC_DIRS[@]}" "${DIST_DIRS[@]}"; do
  [ -e "$target" ] || continue

  if grep -RInE \
    "cdn\.|unpkg\.com|jsdelivr\.net|cdnjs\.cloudflare\.com|googleapis\.com|gstatic\.com|googletagmanager\.com|google-analytics\.com|analytics\.|plausible\.io|umami\.is" \
    "$target" \
    --exclude-dir=node_modules \
    --exclude-dir=.vite \
    --exclude="*.map"; then
    FOUND=1
  fi
done

# 检查最终 HTML 是否引用远程脚本、样式、图片、字体。
for html in web/dist/index.html internal/panel/webdist/index.html; do
  [ -f "$html" ] || continue

  if grep -nE \
    '<script[^>]+src=["'"'"']https?://|<link[^>]+href=["'"'"']https?://|<img[^>]+src=["'"'"']https?://|@import[[:space:]]+url\(["'"'"']?https?://' \
    "$html"; then
    FOUND=1
  fi
done

# 禁止浏览器原生弹窗 — 仅检查源码目录，不检查构建产物（minified JS 会误报）。
for target in "${SRC_DIRS[@]}"; do
  [ -e "$target" ] || continue

  if grep -RInE \
    "window\.(alert|prompt|confirm)[[:space:]]*\(|globalThis\.(alert|prompt|confirm)[[:space:]]*\((^|[^A-Za-z0-9_$])(alert|prompt)[[:space:]]*\(" \
    "$target" \
    --exclude="*.map"; then
    FOUND=1
  fi
done

if [ "$FOUND" = "1" ]; then
  echo "检测到疑似 CDN/远程资源/浏览器原生弹窗引用，请检查上方输出。"
  exit 1
fi

echo "前端安全检查通过：未发现 CDN/远程字体/浏览器原生弹窗。"