import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'team-loop-runtime-'));
let child;
try {
  await run(process.execPath, ['--check', 'server.js']);
  await run(process.execPath, ['--check', 'public/app.js']);
  const port = await startServer();
  const health = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5_000) });
  if (!health.ok) throw new Error(`Health endpoint returned HTTP ${health.status}`);
  const payload = await health.json();
  if (payload?.ok !== true) throw new Error('Health endpoint did not return ok=true');
  const page = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5_000) });
  if (!page.ok || !(await page.text()).includes('<main id="app">')) throw new Error('Dashboard root did not render the app shell');
  await verifyBrowserModuleTree(port, '/app.js');
  process.stdout.write(`runtime check passed: syntax + HTTP ${health.status} + dashboard ${page.status} + browser modules\n`);
} finally {
  child?.kill('SIGTERM');
  await rm(dataDirectory, { recursive: true, force: true });
}

async function verifyBrowserModuleTree(port, entry) {
  const pending = [entry];
  const visited = new Set();
  while (pending.length) {
    const pathname = pending.shift();
    if (visited.has(pathname)) continue;
    visited.add(pathname);
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Browser module ${pathname} returned HTTP ${response.status}`);
    const source = await response.text();
    for (const match of source.matchAll(/(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"](\.\.?\/[^'"]+)['"]/g)) {
      const resolved = new URL(match[1], `http://127.0.0.1:${port}${pathname}`).pathname;
      pending.push(resolved);
    }
  }
}

function run(file, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(file, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('error', reject);
    proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${file} ${args.join(' ')} failed (${code}): ${stderr}`)));
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child?.kill('SIGTERM'); reject(new Error('Server startup timed out')); }, 10_000);
    child = spawn(process.execPath, ['server.js'], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATA_DIR: dataDirectory, WORKSPACE_ROOT: root },
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => {
      const match = String(chunk).match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { if (code && code !== 0) { clearTimeout(timer); reject(new Error(`Server exited (${code}): ${stderr}`)); } });
  });
}
