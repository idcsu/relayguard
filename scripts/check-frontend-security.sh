#!/usr/bin/env bash
set -euo pipefail

echo "正在检查前端安全引用..."

FOUND=0

URL_TARGETS=(
  "frontend/src"
  "frontend/index.html"
  "frontend/vite.config.ts"
  "frontend/tailwind.config.js"
  "frontend/postcss.config.js"
  "web/dist"
  "internal/panel/webdist"
)

DIALOG_TARGETS=(
  "frontend/src"
  "web/dist"
  "internal/panel/webdist"
)

for target in "${URL_TARGETS[@]}"; do
  [ -e "$target" ] || continue
  if grep -RInE \
    "https?://|cdn\.|unpkg\.com|jsdelivr\.net|googleapis\.com|gstatic\.com" \
    "$target" \
    --exclude-dir=node_modules \
    --exclude-dir=.vite \
    --exclude="*.map"; then
    FOUND=1
  fi
done

# package-lock 允许 registry.npmjs.org，但不允许 CDN / 远程字体。
if [ -f frontend/package-lock.json ]; then
  if grep -nE \
    "unpkg\.com|jsdelivr\.net|googleapis\.com|gstatic\.com|cdn\." \
    frontend/package-lock.json; then
    FOUND=1
  fi
fi

# 禁止浏览器原生弹窗。自定义 confirmModal/confirm 函数不算浏览器原生 API。
for target in "${DIALOG_TARGETS[@]}"; do
  [ -e "$target" ] || continue
  if grep -RInE \
    "window\.(alert|prompt|confirm)[[:space:]]*\(|globalThis\.(alert|prompt|confirm)[[:space:]]*\(|(^|[^A-Za-z0-9_$])(alert|prompt)[[:space:]]*\(" \
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
