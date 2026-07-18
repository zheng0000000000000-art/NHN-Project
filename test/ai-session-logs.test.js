import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexSession } from '../src/ai-session-logs.js';

test('Codex session log becomes a safe chronological conversation', () => {
  const rows = [
    { timestamp: '2026-01-01T00:00:00Z', type: 'session_meta', payload: { id: 'abc', cwd: '/repo', model_provider: 'openai' } },
    { timestamp: '2026-01-01T00:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: '로그인 오류를 찾아줘' } },
    { timestamp: '2026-01-01T00:00:02Z', type: 'response_item', payload: { type: 'reasoning', summary: ['private reasoning'] } },
    { timestamp: '2026-01-01T00:00:02Z', type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', message: '인증 코드를 확인하겠습니다.' } },
    { timestamp: '2026-01-01T00:00:03Z', type: 'event_msg', payload: { type: 'agent_message', phase: 'final_answer', message: '쿠키 설정이 원인입니다.' } },
    { timestamp: '2026-01-01T00:00:04Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'rg auth src' } },
    { timestamp: '2026-01-01T00:00:05Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'token=super-secret-value\nfound auth.js' } },
  ];
  const session = parseCodexSession(rows.map((row) => JSON.stringify(row)).join('\n'), { id: 'ais_test' });
  assert.equal(session.title, '로그인 오류를 찾아줘');
  assert.deepEqual(session.messages.map((message) => message.role), ['user', 'assistant', 'assistant', 'tool', 'tool']);
  assert.equal(session.answerCount, 2);
  assert.equal(JSON.stringify(session).includes('private reasoning'), false);
  assert.equal(JSON.stringify(session).includes('super-secret-value'), false);
  assert.match(session.messages.at(-1).content, /\[REDACTED\]/);
});

test('malformed records are ignored', () => {
  const session = parseCodexSession('{bad json}\n');
  assert.equal(session.messageCount, 0);
  assert.deepEqual(session.messages, []);
});
