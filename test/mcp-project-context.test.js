import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Hermetic AI profile: point at a local-only Ollama endpoint so no external
// network/API budget is ever touched by the server under test.
const HERMETIC_AI_ENV = {
  AI_PROVIDER: 'ollama',
  AI_MODEL: 'qwen2.5-coder:14b',
  AI_BASE_URL: 'http://127.0.0.1:11434',
  AI_API_KEY: '',
  OPENAI_API_KEY: '',
};

async function startServer(t) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'team-loop-mcp-context-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      ...HERMETIC_AI_ENV,
      HOST: '127.0.0.1',
      PORT: '0',
      DATA_DIR: dataDirectory,
      WORKSPACE_ROOT: path.resolve('.'),
      TEAM_LOOP_CLI_HOME: path.join(dataDirectory, 'cli-home'),
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
  return { base: `http://127.0.0.1:${port}`, dataDirectory };
}

function post(base, pathname, body, headers = {}) {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Team-Loop-Client': 'web', ...headers },
    body: JSON.stringify(body),
  });
}

function get(base, pathname, headers = {}) {
  return fetch(`${base}${pathname}`, {
    method: 'GET',
    headers: { 'X-Team-Loop-Client': 'web', ...headers },
  });
}

function put(base, pathname, body, headers = {}) {
  return fetch(`${base}${pathname}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Team-Loop-Client': 'web', ...headers },
    body: JSON.stringify(body),
  });
}

function startMcpClient(t, { server, cookie, cliHome }) {
  const child = spawn(process.execPath, [path.resolve('mcp/team-loop-mcp.mjs')], {
    env: { ...process.env, TEAM_LOOP_URL: server, TEAM_LOOP_SESSION_COOKIE: cookie, TEAM_LOOP_CLI_HOME: cliHome },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let buffer = '';
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        waiter.resolve(message);
      }
    }
  });
  let nextId = 1;
  function call(name, args = {}) {
    const id = nextId;
    nextId += 1;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP tool call timed out: ${name}`)), 5000);
      pending.set(id, { resolve: (message) => { clearTimeout(timer); resolve(message); } });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
    return response;
  }
  t.after(() => {
    child.stdin.end();
    child.kill('SIGTERM');
  });
  return { call };
}

test('MCP get_project_context reaches the authenticated GET route and returns persisted context without mutation', async (t) => {
  const { base, dataDirectory } = await startServer(t);

  const registration = await post(base, '/api/auth/register', {
    name: 'ContextReader', password: 'correct-password', signupCode: 'test-signup-code',
  });
  assert.equal(registration.status, 201);
  const cookie = registration.headers.get('set-cookie').split(';', 1)[0];

  const seeded = await put(base, '/api/project-context', { content: 'Ship small, verifiable diffs only.' }, { Cookie: cookie });
  assert.equal(seeded.status, 200);
  const seededContext = (await seeded.json()).projectContext;
  assert.equal(seededContext.content, 'Ship small, verifiable diffs only.');

  const mcp = startMcpClient(t, { server: base, cookie, cliHome: path.join(dataDirectory, 'mcp-cli-home') });

  const firstCall = await mcp.call('get_project_context');
  assert.equal(firstCall.error, undefined);
  assert.equal(firstCall.result.isError, undefined);
  const firstContext = JSON.parse(firstCall.result.content[0].text);
  assert.equal(firstContext.content, seededContext.content);
  assert.equal(firstContext.updatedAt, seededContext.updatedAt);
  assert.equal(firstContext.updatedByUserId, seededContext.updatedByUserId);

  const secondCall = await mcp.call('get_project_context');
  const secondContext = JSON.parse(secondCall.result.content[0].text);
  assert.deepEqual(secondContext, firstContext);

  const finalRead = await get(base, '/api/project-context', { Cookie: cookie });
  assert.equal(finalRead.status, 200);
  const finalContext = (await finalRead.json()).projectContext;
  assert.deepEqual(finalContext, seededContext);
});
