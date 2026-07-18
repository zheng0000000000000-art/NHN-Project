import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunLedger } from '../src/run-ledger.js';

test('run ledger migrates a legacy result and appends immutable attempts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-ledger-'));
  try {
    const results = path.join(root, '.team-loop', 'results');
    await mkdir(results, { recursive: true });
    await writeFile(path.join(results, 'sample-run.result.json'), JSON.stringify({ runId: 'sample-run', verdict: 'FAILED', verifiedAt: '2026-01-01T00:00:00Z' }));
    const ledger = new RunLedger({ workspaceRoot: root });
    const appended = await ledger.append('sample-run', { runId: 'sample-run', verdict: 'PASSED', verifiedAt: '2026-01-02T00:00:00Z' });
    assert.equal(appended.result.attempt, 2);
    assert.equal((await ledger.latest('sample-run')).verdict, 'PASSED');
    assert.equal(JSON.parse(await readFile(path.join(results, 'sample-run', 'attempt-000001.json'), 'utf8')).verdict, 'FAILED');
    assert.equal(JSON.parse(await readFile(path.join(results, 'sample-run', 'attempt-000002.json'), 'utf8')).verdict, 'PASSED');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('run ledger records lifecycle events separately from verification attempts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-ledger-'));
  try {
    const ledger = new RunLedger({ workspaceRoot: root });
    await ledger.recordEvent('sample-run', { type: 'VERIFIED_AWAITING_APPROVAL', attempt: 1 });
    await ledger.recordEvent('sample-run', { type: 'LANDED', attempt: 1, commit: 'abc' });
    assert.deepEqual((await ledger.events('sample-run')).map((item) => item.type), ['VERIFIED_AWAITING_APPROVAL', 'LANDED']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
