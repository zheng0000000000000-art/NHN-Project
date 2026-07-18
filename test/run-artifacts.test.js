import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunArtifactService, normalizeRunDocument, selectVerificationProfile } from '../src/run-artifacts.js';

test('run document is normalized and rejects unsafe paths', () => {
  const value = normalizeRunDocument({ id: 'run-123', title: 'Safe run', changes: [{ path: 'src/a.js' }], verification: { profile: 'node-project' } });
  assert.equal(value.changes[0].path, 'src/a.js');
  assert.deepEqual(normalizeRunDocument({ id: 'draft-run', title: 'Draft run', changes: [], writeScope: ['src/**'], verification: { profile: 'node-project' } }).writeScope, ['src/**']);
  assert.throws(() => normalizeRunDocument({ id: 'run-123', title: 'Bad run', changes: [{ path: '../secret' }], verification: { profile: 'x' } }), /Unsafe/);
});

test('weak profiles are automatically escalated for code and runtime paths', () => {
  assert.deepEqual(selectVerificationProfile('repository-basic', ['README.md']).appliedProfile, 'repository-basic');
  assert.deepEqual(selectVerificationProfile('repository-basic', ['src/store.js']).appliedProfile, 'node-project');
  const runtime = selectVerificationProfile('repository-basic', ['server.js']);
  assert.equal(runtime.appliedProfile, 'verified-run');
  assert.equal(runtime.strength, 'E2E');
  assert.equal(runtime.autoEscalated, true);
});

test('program result is stored separately and failed evidence is appended', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-run-'));
  try {
    await mkdir(path.join(root, '.team-loop', 'runs'), { recursive: true });
    const runPath = path.join(root, '.team-loop', 'runs', 'sample.json');
    await writeFile(runPath, JSON.stringify({ id: 'sample-run', title: 'Sample run', changes: [{ path: 'src/a.js' }], verification: { profile: 'node-project' } }));
    let appliedProfile;
    const verifier = { run: async (task) => { appliedProfile = task.verificationProfile; return { passed: false, status: 'FAILED', profile: task.verificationProfile, changedPaths: ['src/b.js'], scopeViolations: ['src/b.js'], checks: [{ passed: false, file: 'node', args: ['--test'], expectedExit: 0, actualExit: 1 }] }; } };
    const service = new RunArtifactService({ workspaceRoot: root, verifier });
    const output = await service.verifyFile(runPath);
    assert.equal(output.result.verdict, 'FAILED');
    assert.equal(appliedProfile, 'node-project');
    assert.deepEqual(output.result.undeclaredPaths, ['src/b.js']);
    assert.deepEqual(output.result.missingDeclaredPaths, ['src/a.js']);
    assert.match(await readFile(path.join(root, '.team-loop', 'failures', 'events.jsonl'), 'utf8'), /EXIT_MISMATCH/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
