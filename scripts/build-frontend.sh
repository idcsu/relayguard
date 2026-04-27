#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT/frontend"

if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

npm run build

cd "$ROOT"

rm -rf web/dist internal/panel/webdist
mkdir -p web internal/panel

cp -a frontend/dist web/dist
cp -a frontend/dist internal/panel/webdist

echo "前端构建完成："
echo "  web/dist"
echo "  internal/panel/webdist"
