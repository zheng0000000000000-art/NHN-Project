import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { observationFromTask } from '../src/turn-budget-observations.js';

// 실측 2026-07-25: 관측 기록의 reusedServerPack이 undefined였다. 워커는 서버 팩을 재사용하고
// 그 사실을 in-memory 객체에 담았지만 작업 레코드까지 가지 않아, 중복 조립으로 되돌아가도
// 기록으로는 알 수 없었다. 재사용 여부를 남기는 목적이 바로 그 회귀 감시였는데 통로가 없었다.
function taskWith(selectedContext) {
  return {
    id: 'tsk_test',
    allowedPaths: ['src/a.js'],
    acceptanceCriteria: [],
    verification: { changedPaths: ['src/a.js'], checks: [] },
    agentActivity: { preflight: { maxTurns: 40, selectedContext } },
  };
}

test('reuse of the prepared pack reaches the observation', () => {
  const observed = observationFromTask(taskWith({ id: 'ctx_1', sourceCount: 3, estimatedTokens: 3000, reusedServerPack: true }));
  assert.equal(observed.reusedServerPack, true);
});

test('assembling a second pack is recorded as such', () => {
  const observed = observationFromTask(taskWith({ id: 'ctx_2', sourceCount: 3, estimatedTokens: 3000, reusedServerPack: false }));
  assert.equal(observed.reusedServerPack, false, 'a real double assembly must be visible, not blank');
});

// 부재를 "아니오"로 적으면, 기록이 없는 실행이 중복 조립으로 집계된다.
test('a run that never reported it is null, not false', () => {
  const observed = observationFromTask(taskWith({ id: 'ctx_3', sourceCount: 3, estimatedTokens: 3000 }));
  assert.equal(observed.reusedServerPack, null);
  assert.equal(observationFromTask(taskWith(undefined)).reusedServerPack, null);
  assert.equal(observationFromTask({}).reusedServerPack, null);
});

test('a non-boolean cannot masquerade as an answer', () => {
  assert.equal(observationFromTask(taskWith({ reusedServerPack: 'true' })).reusedServerPack, null);
  assert.equal(observationFromTask(taskWith({ reusedServerPack: 1 })).reusedServerPack, null);
});

test('the worker actually puts the flag on the wire', async () => {
  const worker = await readFile('src/cli/main.js', 'utf8');
  assert.match(worker, /reusedServerPack: Boolean\(reused\)/, 'the worker still decides it');
  assert.match(worker, /reusedServerPack: typeof contextPlan\.reusedServerPack === 'boolean' \? contextPlan\.reusedServerPack : null/,
    'and the preflight must carry it, or the observation stays blank');
});
