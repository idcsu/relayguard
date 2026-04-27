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

rm -rf web/dist internal/panel/webdist
mkdir -p web internal/panel

cp -a frontend/dist web/dist
cp -a frontend/dist internal/panel/webdist

echo "前端构建完成："
echo "  web/dist"
echo "  internal/panel/webdist"
