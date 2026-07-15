import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { parseCliArgs, listOption, repeatedOption } from '../src/cli/args.js';
import { CliClient, ApiError } from '../src/cli/client.js';
import { clearSession, loadSession, normalizeServer, saveSession } from '../src/cli/session.js';

test('CLI parser keeps repeated task scope and criteria options', () => {
  const parsed = parseCliArgs([
    'task', 'create', '--title', 'Movement',
    '--allowed-path', 'Game/Player/**',
    '--allowed-path=Tests/Player/**',
    '--criterion', 'Moves with input',
    '--arg=-e', '--arg', 'process.exit(0)',
  ]);
  assert.deepEqual(parsed.positionals, ['task', 'create']);
  assert.equal(parsed.options.title, 'Movement');
  assert.deepEqual(listOption(parsed.options, 'allowed-path'), ['Game/Player/**', 'Tests/Player/**']);
  assert.deepEqual(listOption(parsed.options, 'criterion'), ['Moves with input']);
  assert.deepEqual(repeatedOption(parsed.options, 'arg'), ['-e', 'process.exit(0)']);

  const globalFlag = parseCliArgs(['--json', 'tasks', '--mine']);
  assert.deepEqual(globalFlag.positionals, ['tasks']);
  assert.equal(globalFlag.options.json, true);
  assert.equal(globalFlag.options.mine, true);
});

test('CLI client captures login cookie and sends it to protected requests', async (t) => {
  let protectedCookie = '';
  let protectedClient = '';
  const server = http.createServer((request, response) => {
    if (request.url === '/login') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'team_loop_session=signed-token; HttpOnly; Path=/' });
      response.end('{"ok":true}');
      return;
    }
    if (request.url === '/protected') {
      protectedCookie = request.headers.cookie || '';
      protectedClient = request.headers['x-team-loop-client'] || '';
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"user":"Alice"}');
      return;
    }
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end('{"error":"missing"}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const client = new CliClient({ server: `http://127.0.0.1:${address.port}` });
  await client.request('/login', { method: 'POST', body: {}, authenticated: false });
  assert.equal(client.cookie, 'team_loop_session=signed-token');
  const result = await client.request('/protected');
  assert.equal(result.user, 'Alice');
  assert.equal(protectedCookie, 'team_loop_session=signed-token');
  assert.equal(protectedClient, 'cli');
});

test('CLI client exposes API failures with status and details', async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(409, { 'Content-Type': 'application/json' });
    response.end('{"error":"stale","details":{"currentVersion":4}}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const client = new CliClient({ server: `http://127.0.0.1:${address.port}` });
  await assert.rejects(
    () => client.request('/task'),
    (error) => error instanceof ApiError && error.status === 409 && error.details.currentVersion === 4,
  );
});

test('CLI session is stored per selected server', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'team-loop-cli-'));
  const previous = process.env.TEAM_LOOP_CLI_HOME;
  process.env.TEAM_LOOP_CLI_HOME = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.TEAM_LOOP_CLI_HOME;
    else process.env.TEAM_LOOP_CLI_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const session = { server: normalizeServer('http://localhost:4173/'), cookie: 'team_loop_session=x', user: { id: 'usr_1' } };
  await saveSession(session);
  assert.deepEqual(await loadSession(), session);
  await clearSession();
  assert.deepEqual(await loadSession(), {});
});
