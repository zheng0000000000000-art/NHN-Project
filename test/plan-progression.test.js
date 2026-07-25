import test from 'node:test';
import assert from 'node:assert/strict';
import { selectAutomaticNextPlanTask } from '../src/plan-progression.js';

test('approval releases and selects the only next plan task', () => {
  const completed = task('one', 'DONE');
  const next = task('two', 'READY', ['one']);
  const later = task('three', 'READY', ['two']);
  const result = selectAutomaticNextPlanTask([completed, next, later], completed);
  assert.equal(result.decision, 'START');
  assert.equal(result.task.id, 'two');
});

test('automatic progression stops when multiple branches become ready', () => {
  const completed = task('one', 'DONE');
  const result = selectAutomaticNextPlanTask([
    completed,
    task('two-a', 'READY', ['one']),
    task('two-b', 'READY', ['one']),
  ], completed);
  assert.equal(result.decision, 'ASK');
  assert.deepEqual(result.candidates, ['two-a', 'two-b']);
});

test('automatic progression ignores blocked budgets and incomplete dependencies', () => {
  const completed = task('one', 'DONE');
  const blocked = { ...task('two', 'READY', ['one']), automationGuard: { circuitOpen: true } };
  const waiting = task('three', 'READY', ['two']);
  const result = selectAutomaticNextPlanTask([completed, blocked, waiting], completed);
  assert.equal(result.decision, 'NONE');
});

function task(id, status, dependsOnTaskIds = []) {
  return { id, planId: 'plan_1', status, archived: false, dependsOnTaskIds, automationGuard: { circuitOpen: false } };
}
