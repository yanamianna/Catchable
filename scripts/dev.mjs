import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('../', import.meta.url));
const children = [
  spawn(process.execPath, ['server/index.mjs'], { cwd, stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { cwd, stdio: 'inherit' }),
];
let exiting = false;
function stop(code = 0) { if (exiting) return; exiting = true; for (const p of children) p.kill(); process.exitCode = code; }
for (const p of children) p.on('exit', (code) => stop(code ?? 0));
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
