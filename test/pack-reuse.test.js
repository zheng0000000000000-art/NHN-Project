import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 팩 재사용은 서버(조립·기록)와 워커(수령) 양쪽이 맞물려야 성립한다.
// 두 파일이 어긋나면 조용히 중복 조립으로 되돌아가므로, 계약을 문면으로 잠근다.
const SERVER = await readFile('server.js', 'utf8');
const WORKER = await readFile('src/cli/main.js', 'utf8');

test('the server assembles the pack before it selects who runs the work', () => {
  const budgetAt = SERVER.indexOf('const workBudget = await deriveWorkBudget(current, actor)');
  const executorAt = SERVER.indexOf('const executionSelection = selectExecutor(current, config');
  assert.ok(budgetAt > 0 && executorAt > 0);
  assert.ok(budgetAt < executorAt, 'the pack must be assembled before the executor is chosen, not after');
});

test('the server keeps the pack instead of discarding it', () => {
  assert.match(SERVER, /await contextPacks\.record\(actor, seed, pack/, 'the assembled pack must be recorded');
  assert.match(SERVER, /await contextPacks\.lockPack\(record\.id, actor\)/, 'and locked, so what was measured is what is handed over');
  assert.match(SERVER, /contextPackId: locked\.id/);
});

test('the derived ceiling reaches the worker instead of a constant', () => {
  assert.match(SERVER, /launchBoardWorker\(task, actor, workerSessionCookie\(request\), \{ maxTurns: workBudget\.maxTurns/,
    'the worker must be launched with the ceiling the pack produced');
});

test('the worker prefers the prepared pack and falls back rather than crashing', () => {
  assert.match(WORKER, /const preparedId = task\?\.workBudget\?\.contextPackId/);
  assert.match(WORKER, /const reused = preparedId \? await fetchPreparedPack\(client, preparedId\) : null/);
  assert.match(WORKER, /const record = reused \?\? await assembleContextPack\(client, task\)/,
    'a pack that cannot be fetched must fall back to assembling, not throw');
});

test('reuse is observable, so a silent return to double assembly would show', () => {
  assert.match(WORKER, /reusedServerPack: Boolean\(reused\)/);
});

test('the manual dispatch path can still assemble its own pack', () => {
  assert.match(WORKER, /async function assembleContextPack\(client, task\)/);
  assert.match(WORKER, /'\/api\/context-packs\/prepare'/, 'the standalone path must remain available');
});
