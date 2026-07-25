import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 실측 2026-07-25: queue-agent로 에이전트 큐에 넣은 작업(status READY, executionMode AGENT,
// executionState QUEUED)을 start-next로 시작하니 outcome은 STARTED인데 워커가 뜨지 않고
// 작업이 HUMAN/IN_PROGRESS로 바뀌었다. 시작 지점이 body.executionMode만 보고 기본값 HUMAN을
// 쓴 뒤 그 값으로 작업의 기록을 덮어썼기 때문이다. 같은 작업이 큐에서 37분간 시작되지 않았다.
// 기록해 둔 의도를 실행 지점이 무시하는, 이 저장소에서 반복되는 결함이다.
const SERVER = await readFile('server.js', 'utf8');

function startBranch() {
  const from = SERVER.indexOf('const requestedMode = String(body.executionMode');
  assert.ok(from > 0, 'the mode decision must still be findable');
  return SERVER.slice(from, SERVER.indexOf('const workBudget = await deriveWorkBudget', from));
}

test('a task already queued for an agent starts as agent work', () => {
  const branch = startBranch();
  assert.match(branch, /current\.executionState === 'QUEUED'/,
    'the queue records the intent; the starter must read it');
  assert.match(branch, /String\(current\.executionMode \|\| ''\)\.toUpperCase\(\) === 'AGENT'/);
  assert.match(branch, /queuedForAgent \? 'AGENT' : 'HUMAN'/);
});

test('an explicit request still wins over what the task recorded', () => {
  const branch = startBranch();
  assert.match(branch, /requestedMode === 'AGENT' \? 'AGENT'/);
  assert.match(branch, /requestedMode === 'HUMAN' \? 'HUMAN'/,
    'a caller must be able to take agent-queued work over by hand');
});

test('the default is no longer a blanket HUMAN that overwrites the record', () => {
  assert.ok(!SERVER.includes("String(body.executionMode || 'HUMAN').toUpperCase() === 'AGENT' ? 'AGENT' : 'HUMAN'"),
    'that default silently discarded queue-agent');
});

test('the decided mode is still what gets written back and what gates the worker', () => {
  // 판정을 고쳐도 그 값이 저장·발사에 쓰이지 않으면 아무것도 달라지지 않는다.
  assert.match(SERVER, /next\.executionMode = executionModeValue;/);
  assert.match(SERVER, /next\.executionState = executionModeValue === 'AGENT' \? 'QUEUED' : 'IDLE';/);
  assert.match(SERVER, /body\.launchWorker && executionModeValue === 'AGENT'/);
});
