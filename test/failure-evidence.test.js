import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evidenceBasis, isRerunnableFailure } from '../src/failure-evidence.js';
import { isRerunnableFailure as reexported } from '../src/harness-registry.js';

const EXECUTOR_VERDICT = { kind: 'EXECUTOR_FAILED', lastEvidence: { file: 'agent-executor', args: [], expectedExit: 0 } };
const DELIVERY_VERDICT = { kind: 'NO_DELIVERABLE', lastEvidence: { file: 'agent-delivery', args: [], expectedExit: 0 } };
const REAL_COMMAND = { kind: 'EXIT_MISMATCH', lastEvidence: { file: 'node', args: ['--test'], expectedExit: 0, actualExit: 1 } };
const SCOPE_ONLY = { kind: 'SCOPE_VIOLATION', lastEvidence: { paths: ['Outside.txt'], changedPaths: ['Outside.txt'] } };

test('a non-empty file name is not by itself evidence', () => {
  assert.equal(isRerunnableFailure(EXECUTOR_VERDICT), false);
  assert.equal(isRerunnableFailure(DELIVERY_VERDICT), false);
  assert.equal(isRerunnableFailure({ kind: 'SPAWN_ERROR', lastEvidence: { file: 'missing', spawnError: true } }), false);
  assert.equal(isRerunnableFailure(REAL_COMMAND), true);
});

test('the harness registry and the promotion engine share one evidence rule', () => {
  assert.equal(reexported, isRerunnableFailure, 'both must resolve to the same function, not two copies');
});

test('evidence basis names why a candidate is or is not harness material', () => {
  assert.equal(evidenceBasis([REAL_COMMAND]), 'REPLAYABLE_COMMAND');
  assert.equal(evidenceBasis([SCOPE_ONLY]), 'OBSERVED_STATE');
  assert.equal(evidenceBasis([EXECUTOR_VERDICT, DELIVERY_VERDICT]), 'REPORTED_OUTCOME');
});

test('repetition is the condition of promotion: one-off failures are not candidates', async () => {
  const policy = JSON.parse(await readFile('config/promotion-policy.json', 'utf8'));
  assert.ok(policy.minimumOccurrences >= 2,
    `a single occurrence must not be promotable, got minimumOccurrences=${policy.minimumOccurrences}`);
});
