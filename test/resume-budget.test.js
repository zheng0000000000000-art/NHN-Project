import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TURN_CEILING } from '../src/work-budget.js';

// 실측 2026-07-25 (data/turn-budget-observations.jsonl): 같은 작업 tsk_d5e20865de07이
// 최초 실행에서 maxTurns=40으로, 재개 세 번(17:02·17:08·17:14)에서 모두 12로 돌았다.
// 팩이 예산을 계산해 task.workBudget에 기록해 두는데, 재개 경로가 그것을 워커에 넘기지
// 않아 워커가 제 기본값으로 떨어졌다. 조립한 값이 쓰이는 곳까지 가지 않는 결함이다.
const SERVER = await readFile('server.js', 'utf8');

function resumeBranch() {
  const from = SERVER.indexOf("if (current.status !== 'READY') {");
  const to = SERVER.indexOf('await requireCompletedDependencies(current);', from);
  assert.ok(from > 0 && to > from, 'the resume branch must still be findable');
  return SERVER.slice(from, to);
}

test('resuming hands the worker the budget the pack already decided', () => {
  assert.match(resumeBranch(), /maxTurns: current\.workBudget\?\.maxTurns/,
    'without this the worker silently falls back to its own default');
});

test('the caller can still override, exactly as on the first pickup', () => {
  // READY 경로와 같은 순서여야 한다. 한쪽만 바뀌면 재개와 최초 실행이 다르게 동작한다.
  assert.match(resumeBranch(), /\{ maxTurns: current\.workBudget\?\.maxTurns, \.\.\.body \}/);
  assert.match(SERVER, /\{ maxTurns: workBudget\.maxTurns, \.\.\.body \}/);
});

test('the resume response says what budget it ran with', () => {
  assert.match(resumeBranch(), /workBudget: current\.workBudget \?\? null/,
    'a ceiling that is not reported cannot be checked against the observation');
});

test('resuming does not assemble a second pack for the same work', () => {
  assert.ok(!resumeBranch().includes('deriveWorkBudget'),
    'the pack was locked at pickup; re-deriving would replace what was measured');
});

// 워커의 기본값이 팩의 천장과 다르다는 것이 이 결함의 전제다. 같아지면 이 검사는
// 무의미해지므로, 전제가 사라졌는지 여기서 드러나게 한다.
test('the worker default and the derived ceiling are still different numbers', async () => {
  const worker = await readFile('src/cli/main.js', 'utf8');
  assert.match(worker, /numberOption\(options, 'max-turns', 12\)/);
  assert.equal(TURN_CEILING.value, 40);
  assert.notEqual(TURN_CEILING.value, 12, 'if these converge, the defect would have hidden itself');
});
