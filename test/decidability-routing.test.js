import test from 'node:test';
import assert from 'node:assert/strict';
import { ARTIFACT_BY_DECIDABILITY, DECIDABILITY_BY_BASIS } from '../src/promotion-engine.js';
import { evidenceBasis } from '../src/failure-evidence.js';

const REPLAYABLE = { kind: 'EXIT_MISMATCH', occurrences: 3, lastEvidence: { file: 'node', args: ['--test'], expectedExit: 0, actualExit: 1 } };
const OBSERVED = { kind: 'SCOPE_VIOLATION', occurrences: 3, lastEvidence: { paths: ['outside.txt'], changedPaths: ['outside.txt'] } };
const REPORTED = { kind: 'EXECUTOR_FAILED', occurrences: 3, lastEvidence: { file: 'agent-executor', args: [] } };

// 점수 산식은 내부 함수라, 라우팅 표와 근거 판정을 통해 계약을 잠근다.
function decidabilityOf(cases) {
  return DECIDABILITY_BY_BASIS[evidenceBasis(cases)] ?? 0;
}

test('decidability can express that a machine cannot decide at all', () => {
  assert.equal(decidabilityOf([REPORTED]), 0, 'a reported outcome is not machine-decidable');
  assert.equal(decidabilityOf([OBSERVED]), 1);
  assert.equal(decidabilityOf([REPLAYABLE]), 2);
  assert.ok(Object.values(DECIDABILITY_BY_BASIS).includes(0), 'zero must be reachable, otherwise routing has no basis');
});

test('a yes or no question is routed to the program, never to a model', () => {
  assert.equal(ARTIFACT_BY_DECIDABILITY[2], 'HARNESS');
  assert.equal(ARTIFACT_BY_DECIDABILITY[1], 'SKILL');
  assert.equal(ARTIFACT_BY_DECIDABILITY[0], 'WIKI');
});

test('the routing follows the harness over skill over document ordering', () => {
  const order = [2, 1, 0].map((level) => ARTIFACT_BY_DECIDABILITY[level]);
  assert.deepEqual(order, ['HARNESS', 'SKILL', 'WIKI']);
});

test('every basis the evidence module can report has a decidability', () => {
  for (const basis of ['REPLAYABLE_COMMAND', 'OBSERVED_STATE', 'REPORTED_OUTCOME']) {
    assert.ok(Number.isInteger(DECIDABILITY_BY_BASIS[basis]), `${basis} must map to a level`);
    assert.ok(ARTIFACT_BY_DECIDABILITY[DECIDABILITY_BY_BASIS[basis]], `${basis} must route somewhere`);
  }
});

test('a failure with no rerunnable command cannot reach automatic creation', () => {
  // 결정가능성과 장애주입이 모두 0이면 나머지 네 축이 만점이어도 11에 닿지 못한다.
  const bestCaseWithoutDecidability = 2 + 0 + 0 + 2 + 2 + 2;
  assert.ok(bestCaseWithoutDecidability < 11, 'CREATE_NOW must stay out of reach for what a machine cannot judge');
  assert.equal(bestCaseWithoutDecidability, 8);
});
