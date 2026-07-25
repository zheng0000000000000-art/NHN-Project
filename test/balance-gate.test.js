import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);
const checker = path.resolve('tools/verification/check-balance-gate.mjs');

test('balance gate returns zero for targets met and nonzero with metric evidence otherwise', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'balance-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const request = {
    provider: 'combat-v1',
    mode: 'evaluate',
    seed: 42,
    runs: 20,
    spec: {
      balanceId: 'gate-test',
      parameters: { enemyAttack: 1 },
      parameterSpace: [{ parameterId: 'enemyAttack', path: 'rooms/0/enemies/attack', minimum: 1, maximum: 1, step: 1 }],
      metrics: [{ metricId: 'completionRate', minimum: 0, maximum: 100 }],
    },
    baseline: {
      player: { maxHp: 100, attack: 20 },
      rooms: [{ enemies: { hp: 10, attack: 1, count: 1 }, rewards: { commonDropRate: 0, healAmount: 0 } }],
    },
  };
  const passing = path.join(root, 'passing.json');
  await writeFile(passing, JSON.stringify(request));
  const pass = await run(process.execPath, [checker, passing]);
  assert.equal(JSON.parse(pass.stdout).passed, true);

  request.spec.metrics[0].minimum = 101;
  const failing = path.join(root, 'failing.json');
  await writeFile(failing, JSON.stringify(request));
  await assert.rejects(
    run(process.execPath, [checker, failing]),
    (error) => {
      const output = JSON.parse(error.stdout);
      assert.equal(output.passed, false);
      assert.equal(output.failedMetrics[0].metricId, 'completionRate');
      return true;
    },
  );
});

test('balance gate mode flag overrides the request mode and rejects unknown modes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'balance-gate-mode-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const request = {
    provider: 'combat-v1',
    mode: 'tune',
    seed: 42,
    runs: 20,
    maxCandidates: 1,
    spec: {
      balanceId: 'gate-mode-test',
      parameters: { enemyAttack: 1 },
      parameterSpace: [{ parameterId: 'enemyAttack', path: 'rooms/0/enemies/attack', minimum: 1, maximum: 1, step: 1 }],
      metrics: [{ metricId: 'completionRate', minimum: 0, maximum: 100 }],
    },
    baseline: {
      player: { maxHp: 100, attack: 20 },
      rooms: [{ enemies: { hp: 10, attack: 1, count: 1 }, rewards: { commonDropRate: 0, healAmount: 0 } }],
    },
  };
  const requestPath = path.join(root, 'request.json');
  await writeFile(requestPath, JSON.stringify(request));

  const tuned = await run(process.execPath, [checker, requestPath]);
  assert.equal(JSON.parse(tuned.stdout).mode, 'tune');

  const evaluated = await run(process.execPath, [checker, requestPath, '--mode=evaluate']);
  const evaluatedOutput = JSON.parse(evaluated.stdout);
  assert.equal(evaluatedOutput.mode, 'evaluate');
  assert.equal(evaluatedOutput.passed, true);

  await assert.rejects(
    run(process.execPath, [checker, requestPath, '--mode=bogus']),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /unknown mode/);
      return true;
    },
  );
});
