import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { injectionReadiness } from '../src/failure-evidence.js';

// 실측: failureInjection이 decidability를 그대로 복사하고 있었다. 12점 중 4점이 한 번의
// 측정에서 나오고, 판정자는 같은 증거를 두 번 세게 된다. 주입 명세가 실제로 요구하는 것은
// 돌릴 명령과 손댈 file 둘 다이므로, 두 질문은 갈라져야 한다.
const COMMAND_ONLY = { kind: 'CHECK_FAILED', lastEvidence: { file: 'node', args: ['--test'], actualExit: 1 } };
const TARGET_ONLY = { kind: 'STATE_DRIFT', lastEvidence: { changedPaths: ['src/store.js'] } };
const BOTH = { kind: 'CHECK_FAILED', lastEvidence: { file: 'node', args: ['--test'], changedPaths: ['src/store.js'] } };
const NEITHER = { kind: 'REPORTED', lastEvidence: { message: '에이전트가 실패했다고 보고함' } };

test('an injection spec needs both a command to run and something to break', () => {
  assert.equal(injectionReadiness([BOTH]), 2);
  assert.equal(injectionReadiness([COMMAND_ONLY]), 1, 'nothing to mutate, so nothing to inject');
  assert.equal(injectionReadiness([TARGET_ONLY]), 1, 'nothing to rerun, so nothing proves it caught');
  assert.equal(injectionReadiness([NEITHER]), 0);
});

test('the two axes disagree exactly where the evidence is one-sided', async () => {
  const { evidenceBasis } = await import('../src/failure-evidence.js');
  const decidability = { REPLAYABLE_COMMAND: 2, OBSERVED_STATE: 1, REPORTED_OUTCOME: 0 };
  // 이 케이스가 옛 규칙에서 4점 만점을 받던 자리다. 다시 돌릴 수는 있지만 주입은 못 한다.
  assert.equal(decidability[evidenceBasis([COMMAND_ONLY])], 2);
  assert.equal(injectionReadiness([COMMAND_ONLY]), 1);
});

test('a delivery-gate label is not a command, so it cannot raise the score', () => {
  const synthetic = { kind: 'EXECUTOR_FAILED', lastEvidence: { file: 'agent-executor', args: [], changedPaths: ['server.js'] } };
  assert.equal(injectionReadiness([synthetic]), 1, 'only the target counts; the file is a label');
});

test('any one path field is enough of a target', () => {
  assert.equal(injectionReadiness([{ lastEvidence: { paths: ['a.js'] } }]), 1);
  assert.equal(injectionReadiness([{ lastEvidence: { path: 'a.js' } }]), 1);
  assert.equal(injectionReadiness([{ lastEvidence: { path: '   ' } }]), 0, 'blank is not a target');
  assert.equal(injectionReadiness([{ lastEvidence: { changedPaths: [] } }]), 0);
});

test('the axis is no longer wired to decidability', async () => {
  const source = await readFile('src/promotion-engine.js', 'utf8');
  assert.ok(!/failureInjection: decidability/.test(source),
    'copying decidability makes 4 of 12 points come from one measurement');
  assert.match(source, /failureInjection: injectionReadiness\(cases\)/);
});

// 실측으로 확인한 것을 회귀로 잠근다: 실제 코퍼스에서 두 축은 갈라지고, 주입 가능한
// 케이스는 아직 하나도 없다. 이 값이 움직이면 근거가 실제로 좋아졌거나 규칙이 헐거워진 것이다.
test('the real corpus still shows the two axes are not the same signal', async () => {
  const { evidenceBasis } = await import('../src/failure-evidence.js');
  const decidability = { REPLAYABLE_COMMAND: 2, OBSERVED_STATE: 1, REPORTED_OUTCOME: 0 };
  const db = JSON.parse(await readFile('data/failure-cases.json', 'utf8'));
  const cases = db.cases || [];
  const diverging = cases.filter((item) => (decidability[evidenceBasis([item])] ?? 0) !== injectionReadiness([item]));
  assert.ok(cases.length > 0, 'the corpus must not be empty for this to mean anything');
  assert.ok(diverging.length > 0,
    'if the axes never disagree, one of them is not carrying its own signal');
});
