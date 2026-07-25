import test from 'node:test';
import assert from 'node:assert/strict';
import { IdleRunner } from '../src/idle-runner.js';

// 시간을 손으로 밀 수 있는 시계.
function clock(start = 1_000) {
  let value = start;
  return { now: () => value, advance: (ms) => { value += ms; } };
}

test('an idle workspace runs the job', async () => {
  let ran = 0;
  const runner = new IdleRunner({
    name: 'probe', isIdle: () => ({ idle: true }), run: async () => { ran += 1; return { ok: true }; }, minGapMs: 0,
  });
  const outcome = await runner.tick();
  assert.equal(outcome.ran, true);
  assert.equal(outcome.reason, 'RAN');
  assert.equal(ran, 1);
});

test('a busy workspace does not run the job, and says why', async () => {
  let ran = 0;
  const runner = new IdleRunner({
    name: 'probe',
    isIdle: () => ({ idle: false, reason: 'AGENT_RUNNING' }),
    run: async () => { ran += 1; },
    minGapMs: 0,
  });
  const outcome = await runner.tick();
  assert.equal(outcome.ran, false);
  assert.equal(outcome.reason, 'BUSY');
  assert.equal(outcome.detail, 'AGENT_RUNNING');
  assert.equal(ran, 0, 'the job must not compete with active work');
});

test('the minimum gap keeps an idle workspace from being hammered', async () => {
  const time = clock();
  let ran = 0;
  const runner = new IdleRunner({
    name: 'probe', isIdle: () => ({ idle: true }), run: async () => { ran += 1; }, minGapMs: 10_000, now: time.now,
  });
  assert.equal((await runner.tick()).reason, 'RAN');
  assert.equal((await runner.tick()).reason, 'TOO_SOON');
  time.advance(9_999);
  assert.equal((await runner.tick()).reason, 'TOO_SOON');
  time.advance(2);
  assert.equal((await runner.tick()).reason, 'RAN');
  assert.equal(ran, 2);
});

test('a slow job is never started twice at once', async () => {
  let started = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const runner = new IdleRunner({
    name: 'probe', isIdle: () => ({ idle: true }), run: async () => { started += 1; await gate; }, minGapMs: 0,
  });
  const first = runner.tick();
  const second = await runner.tick();
  assert.equal(second.reason, 'ALREADY_RUNNING');
  release();
  await first;
  assert.equal(started, 1);
});

test('a throwing job is recorded, not swallowed, and does not wedge the runner', async () => {
  const time = clock();
  let attempts = 0;
  const runner = new IdleRunner({
    name: 'probe',
    isIdle: () => ({ idle: true }),
    run: async () => { attempts += 1; throw new Error('injection exploded'); },
    minGapMs: 0,
    now: time.now,
  });
  const outcome = await runner.tick();
  assert.equal(outcome.reason, 'THREW');
  assert.match(outcome.error, /injection exploded/);
  assert.equal(runner.consecutiveFailures, 1);
  assert.equal(runner.running, false, 'the runner must not stay latched after a throw');
  time.advance(1);
  await runner.tick();
  assert.equal(attempts, 2, 'a later tick must still be able to run');
  assert.equal(runner.consecutiveFailures, 2);
});

test('a failing result increments the failure count and a passing one clears it', async () => {
  const time = clock();
  let ok = false;
  const runner = new IdleRunner({
    name: 'probe', isIdle: () => ({ idle: true }), run: async () => ({ ok }), minGapMs: 0, now: time.now,
  });
  await runner.tick();
  assert.equal(runner.consecutiveFailures, 1);
  ok = true;
  time.advance(1);
  await runner.tick();
  assert.equal(runner.consecutiveFailures, 0);
});

test('every outcome is published to the observer and exposed as status', async () => {
  const seen = [];
  const runner = new IdleRunner({
    name: 'idle-verify',
    isIdle: () => ({ idle: false, reason: 'BOARD_WORKER_ACTIVE' }),
    run: async () => ({ ok: true }),
    minGapMs: 0,
    onResult: (outcome) => seen.push(outcome),
  });
  await runner.tick();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].name, 'idle-verify');
  assert.equal(runner.status().lastOutcome.reason, 'BUSY');
  assert.equal(runner.status().scheduled, false);
});

test('scheduling is opt-in and stoppable', () => {
  const runner = new IdleRunner({ name: 'probe', isIdle: () => ({ idle: true }), run: async () => ({ ok: true }) });
  assert.equal(runner.status().scheduled, false);
  runner.start();
  assert.equal(runner.status().scheduled, true);
  runner.start();
  runner.stop();
  assert.equal(runner.status().scheduled, false);
});

test('a runner without a real idle probe or job refuses to be built', () => {
  assert.throws(() => new IdleRunner({ name: 'x', run: async () => {} }), /isIdle/);
  assert.throws(() => new IdleRunner({ name: 'x', isIdle: () => ({ idle: true }) }), /run/);
});
