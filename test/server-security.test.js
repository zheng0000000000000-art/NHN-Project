import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

async function startServer(t) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'team-loop-server-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      DATA_DIR: dataDirectory,
      WORKSPACE_ROOT: path.resolve('.'),
      SIGNUP_CODE: 'test-signup-code',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server startup timeout: ${stderr}`)), 10_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited during startup (${code}): ${stderr}`));
    });
    child.stdout.on('data', (chunk) => {
      const match = chunk.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve)).catch(() => {});
    await rm(dataDirectory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${port}`;
}

function post(base, pathname, body, headers = {}) {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Team-Loop-Client': 'web', ...headers },
    body: JSON.stringify(body),
  });
}

test('POST requests without the trusted client header are rejected', async (t) => {
  const base = await startServer(t);
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Alice', password: 'wrong-password' }),
  });
  assert.equal(response.status, 403);
});

test('async password verification does not block health responses and auth attempts are rate limited', async (t) => {
  const base = await startServer(t);
  const registration = await post(base, '/api/auth/register', {
    name: 'Alice', password: 'correct-password', signupCode: 'test-signup-code',
  });
  assert.equal(registration.status, 201);

  const attempts = Array.from({ length: 8 }, () => post(base, '/api/auth/login', {
    name: 'Alice', password: 'wrong-password',
  }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const started = performance.now();
  const health = await fetch(`${base}/api/health`);
  const latencyMs = performance.now() - started;
  assert.equal(health.status, 200);
  assert.ok(latencyMs < 250, `health response was blocked for ${latencyMs.toFixed(1)}ms`);
  await Promise.all(attempts);

  let finalStatus = 0;
  for (let index = 0; index < 11; index += 1) {
    const response = await post(base, '/api/auth/login', { name: 'RateLimitedUser', password: 'wrong-password' });
    finalStatus = response.status;
  }
  assert.equal(finalStatus, 429);
});

test('external usage endpoint requires authentication and rate limits collectors', async (t) => {
  const base = await startServer(t);
  const body = {
    schemaVersion: 1,
    collectedAt: new Date().toISOString(),
    tool: 'claude-code',
    machineId: 'machine-test',
    quota: {
      source: 'statusline-stdin',
      windows: [{ limitId: 'claude-code', windowId: 'five-hour', usedPercent: 25 }],
    },
  };
  const unauthenticated = await post(base, '/api/usage/external', body, { 'X-Team-Loop-Client': 'collector' });
  assert.equal(unauthenticated.status, 401);

  const registration = await post(base, '/api/auth/register', {
    name: 'CollectorUser', password: 'correct-password', signupCode: 'test-signup-code',
  });
  assert.equal(registration.status, 201);
  const cookie = registration.headers.get('set-cookie').split(';', 1)[0];
  let status = 0;
  for (let index = 0; index < 5; index += 1) {
    const response = await post(base, '/api/usage/external', { ...body, collectedAt: new Date(Date.now() + index).toISOString() }, {
      'X-Team-Loop-Client': 'collector', Cookie: cookie,
    });
    status = response.status;
  }
  assert.equal(status, 429);
});
