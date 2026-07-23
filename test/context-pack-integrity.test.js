import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const checker = path.resolve('tools/verification/check-context-pack.mjs');

test('context pack integrity harness distinguishes valid, stale, and malformed contracts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-context-pack-'));
  const inputPath = path.join(root, 'input.txt');
  await writeFile(inputPath, 'stable input', 'utf8');
  const sha256 = createHash('sha256').update(Buffer.from('stable input')).digest('hex');
  const packPath = path.join(root, 'pack.json');
  await writeFile(packPath, JSON.stringify({
    packId: 'pack-1',
    requiredInputs: [{ path: 'input.txt', sha256 }],
    readOrder: ['input.txt'],
    writeScope: ['output/**'],
    forbiddenActions: [],
  }), 'utf8');

  assert.equal(run(packPath, root).status, 0);
  await writeFile(inputPath, 'changed', 'utf8');
  assert.equal(run(packPath, root).status, 1);
  await writeFile(packPath, '{}', 'utf8');
  assert.equal(run(packPath, root).status, 2);
});

function run(packPath, root) {
  return spawnSync(process.execPath, [checker, packPath, root], { encoding: 'utf8' });
}
