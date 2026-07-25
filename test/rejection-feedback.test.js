import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 실측 7회차: 리뷰어가 REJECT와 함께 구체적 사유를 남겼는데, 워커 프롬프트는 task.aiReview를
// 한 번도 읽지 않았다. 재개한 에이전트는 왜 거절당했는지 모른 채 같은 코드를 다시 낸다.
// 기록해 두고 고칠 쪽에 전달하지 않는 것은 기록하지 않은 것과 같다.
const WORKER = await readFile('src/cli/main.js', 'utf8');

function dispatchPrompt() {
  const from = WORKER.indexOf('function buildDispatchPrompt(');
  const to = WORKER.indexOf('function buildRetryPrompt(', from);
  assert.ok(from > 0 && to > from);
  return WORKER.slice(from, to);
}

test('the dispatch prompt carries a standing rejection back to the agent', () => {
  const prompt = dispatchPrompt();
  assert.match(prompt, /task\.aiReview\?\.verdict === 'REJECT'/,
    'only a rejection is fed back; an approval is not a repair instruction');
  assert.match(prompt, /A reviewer already rejected this work/);
  assert.match(prompt, /rejection\.summary/, 'the reason must travel, not just the fact');
  assert.match(prompt, /for \(const concern of rejection\.concerns \|\| \[\]\)/);
});

test('the agent is told the earlier work survives, so it repairs instead of restarting', () => {
  assert.match(dispatchPrompt(), /still in this worktree\. Fix what the reviewer named rather than starting over/);
});

test('the rejection is stated before the scope constraint, not buried after it', () => {
  const prompt = dispatchPrompt();
  const rejectAt = prompt.indexOf('A reviewer already rejected this work');
  const scopeAt = prompt.indexOf('# HARD scope constraint');
  assert.ok(rejectAt > 0 && scopeAt > rejectAt, 'what to fix comes before where it may be fixed');
});
