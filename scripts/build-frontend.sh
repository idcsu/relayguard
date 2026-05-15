#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT/frontend"

npm install

npm run build

cd "$ROOT"

test -d frontend/dist || {
  echo "错误：frontend/dist 未生成，前端构建失败。"
  exit 1
}

rm -rf internal/panel/webdist
mkdir -p internal/panel

cp -a frontend/dist internal/panel/webdist

echo "前端构建完成："
echo "  frontend/dist"
echo "  internal/panel/webdist"