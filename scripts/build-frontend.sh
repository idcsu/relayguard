#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT/web"

npm install

npm run build

cd "$ROOT"

test -d web/dist || {
  echo "错误：web/dist 未生成，前端构建失败。"
  exit 1
}

rm -rf internal/panel/webdist
mkdir -p internal/panel

cp -a web/dist internal/panel/webdist

echo "前端构建完成："
echo "  web/dist"
echo "  internal/panel/webdist"