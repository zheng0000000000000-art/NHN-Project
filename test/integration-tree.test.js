import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  conflictMarkerHits,
  inProgressOperations,
  inspectIntegrationTree,
  integrationProblems,
  mainWorktree,
} from '../tools/verification/check-integration-tree.mjs';

const GIT = process.env.TEAM_LOOP_GIT_BIN || 'git';

// 커밋까지 가능한 임시 저장소를 만든다.
async function tempRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-integration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = (...args) => execFileSync(GIT, [
    '-c', 'user.email=harness@example.com',
    '-c', 'user.name=harness',
    '-c', 'commit.gpgsign=false',
    ...args,
  ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  run('init', '-q');
  return { root, run };
}

test('a clean integration tree produces no problems', () => {
  assert.deepEqual(integrationProblems({ operations: [], hits: [] }), []);
  assert.deepEqual(integrationProblems({}), []);
});

test('an unfinished git operation is reported as a problem', () => {
  const problems = integrationProblems({ operations: ['MERGE_HEAD'], hits: [] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /unfinished git operation/);
  assert.match(problems[0], /MERGE_HEAD/);
});

test('every conflict marker hit becomes its own problem', () => {
  const problems = integrationProblems({
    operations: [],
    hits: ['test/a.js:91:<<<<<<< HEAD', 'test/a.js:212:>>>>>>> task/x'],
  });
  assert.equal(problems.length, 2);
  problems.forEach((problem) => assert.match(problem, /conflict marker committed/));
});

test('an unfinished merge and a conflict marker are reported together', () => {
  const problems = integrationProblems({ operations: ['rebase-merge'], hits: ['a.js:1:<<<<<<< HEAD'] });
  assert.equal(problems.length, 2);
});

test('a committed conflict marker in a real repository is detected', async (t) => {
  const { root, run } = await tempRepository(t);
  await writeFile(path.join(root, 'clean.js'), 'export const ok = true;\n', 'utf8');
  run('add', '.');
  run('commit', '-qm', 'clean');
  assert.deepEqual(conflictMarkerHits(root), [], 'a clean repository must report nothing');

  await writeFile(
    path.join(root, 'broken.js'),
    ['<<<<<<< HEAD', 'export const value = 1;', '=======', 'export const value = 2;', '>>>>>>> other', ''].join('\n'),
    'utf8',
  );
  run('add', '.');
  run('commit', '-qm', 'broken');

  const hits = conflictMarkerHits(root);
  assert.ok(hits.length >= 2, `expected marker hits, got ${JSON.stringify(hits)}`);
  assert.ok(hits.some((hit) => hit.includes('broken.js')));
  assert.ok(integrationProblems({ hits }).length >= 2);
});

test('an untracked file with markers is ignored because it never reaches the integration tree', async (t) => {
  const { root, run } = await tempRepository(t);
  await writeFile(path.join(root, 'clean.js'), 'export const ok = true;\n', 'utf8');
  run('add', '.');
  run('commit', '-qm', 'clean');
  await writeFile(path.join(root, 'scratch.js'), '<<<<<<< HEAD\n', 'utf8');
  assert.deepEqual(conflictMarkerHits(root), []);
});

test('a directory with no git metadata reports no in-progress operation', () => {
  assert.deepEqual(inProgressOperations(null), []);
  assert.deepEqual(inProgressOperations(path.join(os.tmpdir(), 'team-loop-missing-git-dir')), []);
});

test('this repository resolves its own integration tree and is currently clean', () => {
  const root = mainWorktree(process.cwd());
  assert.ok(root, 'the integration tree must resolve');
  const result = inspectIntegrationTree(process.cwd());
  assert.deepEqual(result.problems, [], `integration tree is not clean: ${result.problems.join(' | ')}`);
});
