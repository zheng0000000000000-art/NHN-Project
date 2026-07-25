import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkTokenEfficiency } from '../tools/verification/check-token-efficiency.mjs';

test('the token efficiency harness passes against the completed implementation', async () => {
  const violations = await checkTokenEfficiency();
  assert.deepEqual(violations, [], `token efficiency contracts regressed:\n${violations.join('\n')}`);
});

test('the harness is registered as a profile future tasks can select', async () => {
  const profiles = JSON.parse(await readFile('config/verification-profiles.json', 'utf8')).profiles;
  const profile = profiles['token-efficiency-regression'];
  assert.ok(profile, 'token-efficiency-regression must be a selectable verification profile');
  assert.equal(profile.commands.length, 1);
  assert.equal(profile.commands[0].file, 'node');
  assert.deepEqual(profile.commands[0].args, ['tools/verification/check-token-efficiency.mjs']);
  assert.equal(profile.commands[0].expectedExit, 0);
});

test('the harness reports one violation per broken contract, naming the contract', async () => {
  const source = await readFile('tools/verification/check-token-efficiency.mjs', 'utf8');
  for (const contract of ['context-size', 'maximum-turns', 'context-pack-receipts', 'review-safe-state', 'start-work-priority']) {
    assert.ok(source.includes(`'${contract}'`), `the harness must cover the ${contract} contract`);
  }
});
