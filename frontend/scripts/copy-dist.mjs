import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const src = path.resolve(__dirname, '..', 'dist');
const targets = [
  path.join(root, 'web', 'dist'),
  path.join(root, 'internal', 'panel', 'webdist')
];

for (const target of targets) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(src, target, { recursive: true });
}
console.log('前端构建产物已复制到 web/dist 和 internal/panel/webdist');
