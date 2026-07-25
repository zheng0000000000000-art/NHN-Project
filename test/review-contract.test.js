import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewProse, partitionChangedPaths, verdictOnLine } from '../src/review-contract.js';

// 실측: 수동 탐침에서 코덱스가 형식 없이 물었을 때 실제로 diff를 열고 낸 답이다.
const REAL = [
  'codex',
  '`src/worktree.js` now safely removes a task branch only when its commits are reachable from `HEAD`.',
  '',
  'APPROVE',
].join('\n');

test('a plain prose review yields the verdict and the finding above it', () => {
  const parsed = parseReviewProse(REAL);
  assert.equal(parsed.verdict, 'APPROVE');
  assert.match(parsed.summary, /src\/worktree\.js/);
  assert.deepEqual(parsed.concerns, []);
  assert.equal(parsed.reason, null);
});

test('a rejection carries its finding into concerns so the reason is not lost', () => {
  const parsed = parseReviewProse('server.js still writes an unbounded blob.\n\nREJECT');
  assert.equal(parsed.verdict, 'REJECT');
  assert.deepEqual(parsed.concerns, ['server.js still writes an unbounded blob.']);
});

test('markdown decoration around the verdict does not hide it', () => {
  assert.equal(verdictOnLine('**APPROVE**'), 'APPROVE');
  assert.equal(verdictOnLine('  approve.  '), 'APPROVE');
  assert.equal(verdictOnLine('`REJECT`'), 'REJECT');
});

test('a sentence merely containing the word is not a verdict line', () => {
  assert.equal(verdictOnLine('I would approve this change.'), null);
  assert.equal(verdictOnLine('Reject if the test is missing.'), null);
});

// 형식을 안 보여주므로 리뷰어가 형식을 베낄 수 없다. 대신 아무 말도 안 하고 끝낼 수는 있다.
test('an answer with no verdict line is refused rather than guessed at', () => {
  const parsed = parseReviewProse('The change looks reasonable to me.');
  assert.equal(parsed.verdict, null);
  assert.equal(parsed.reason, 'NO_VERDICT_LINE');
});

test('a bare verdict with nothing to back it is refused', () => {
  assert.equal(parseReviewProse('APPROVE').reason, 'NO_SUMMARY_LINE');
  assert.equal(parseReviewProse('## Verdict\n\nAPPROVE').reason, 'NO_SUMMARY_LINE',
    'a heading is not a finding');
  assert.equal(parseReviewProse('Summary:\n---\nAPPROVE').reason, 'NO_SUMMARY_LINE');
});

test('the last verdict wins when the reviewer thinks aloud before deciding', () => {
  const parsed = parseReviewProse([
    'I first considered REJECT because the test name was unclear.',
    'src/worktree.js now guards the branch delete behind a reachability check.',
    'APPROVE',
  ].join('\n'));
  assert.equal(parsed.verdict, 'APPROVE');
  assert.match(parsed.summary, /reachability check/);
});

test('list markers and bold are stripped from the finding', () => {
  const parsed = parseReviewProse('- **server.js** now bounds the excerpt.\nAPPROVE');
  assert.equal(parsed.summary, 'server.js now bounds the excerpt.');
});

// 실측 8회차: 새로 만든 테스트 파일이 untracked라 `git diff HEAD~1`에 안 나왔고,
// 리뷰어는 "테스트가 없다"고 정확히 판정했다. 틀린 것은 우리가 보여준 증거였다.
const PORCELAIN = [
  ' M server.js',
  ' M src/worktree.js',
  '?? test/task-delete-branch.test.js',
].join('\n');

test('a new file is told apart from a modified one, because no diff can show it', () => {
  const parts = partitionChangedPaths(PORCELAIN, ['server.js', 'src/worktree.js', 'test/task-delete-branch.test.js']);
  assert.deepEqual(parts.created, ['test/task-delete-branch.test.js']);
  assert.deepEqual(parts.modified, ['server.js', 'src/worktree.js']);
});

test('untracked files outside the change set do not leak into the review', () => {
  const parts = partitionChangedPaths('?? scratch/notes.md\n M server.js', ['server.js']);
  assert.deepEqual(parts.created, []);
  assert.deepEqual(parts.modified, ['server.js']);
});

test('windows separators and quoted paths still match', () => {
  const parts = partitionChangedPaths('?? "test/new file.js"', ['test\\new file.js']);
  assert.deepEqual(parts.created, ['test/new file.js']);
});

test('no status output means nothing is claimed to be new', () => {
  assert.deepEqual(partitionChangedPaths('', ['server.js']), { created: [], modified: ['server.js'] });
  assert.deepEqual(partitionChangedPaths(null, null), { created: [], modified: [] });
});
