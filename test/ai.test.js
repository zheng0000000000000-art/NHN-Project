import test from 'node:test';
import assert from 'node:assert/strict';
import { AIService } from '../src/ai.js';

function responseWith(value) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        id: 'resp_test_1',
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: JSON.stringify(value) }],
        }],
        usage: {
          input_tokens: 120,
          input_tokens_details: { cached_tokens: 20 },
          output_tokens: 30,
          output_tokens_details: { reasoning_tokens: 10 },
          total_tokens: 150,
        },
      };
    },
  };
}

test('AI service stays disabled until key and model are configured', () => {
  const ai = new AIService({ apiKey: '', model: '' });
  assert.equal(ai.status().enabled, false);
  assert.deepEqual(ai.status().missing, ['OPENAI_API_KEY', 'AI_MODEL']);
});

test('AI service can use Ollama without an API key', () => {
  const ai = new AIService({ provider: 'ollama', apiKey: '', model: 'qwen2.5-coder:14b' });
  assert.equal(ai.status().enabled, true);
  assert.equal(ai.status().provider, 'ollama');
  assert.equal(ai.status().baseUrl, 'http://127.0.0.1:11434');
  assert.deepEqual(ai.status().missing, []);
});

test('AI task draft uses the Responses API with strict structured output', async () => {
  let captured;
  const draft = {
    title: '체력 UI 갱신',
    description: '플레이어 체력 변경을 UI에 반영한다.',
    priority: 20,
    allowedPaths: ['Game/UI/**', 'Tests/UI/**'],
    verificationProfile: 'node-project',
    acceptanceCriteria: ['체력 변경 시 UI가 갱신된다.'],
    risks: ['이벤트 중복 구독'],
  };
  const ai = new AIService({
    apiKey: 'test-key',
    model: 'test-model',
    baseUrl: 'https://api.openai.com/v1',
    fetchImpl: async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return responseWith(draft);
    },
  });

  const result = await ai.draftTask({
    goal: '체력 UI를 구현한다.',
    tasks: [],
    profiles: { 'node-project': { id: 'node-project', label: 'Node' } },
  });

  assert.equal(captured.url, 'https://api.openai.com/v1/responses');
  assert.equal(captured.init.headers.Authorization, 'Bearer test-key');
  assert.equal(captured.body.store, false);
  assert.equal(captured.body.text.format.type, 'json_schema');
  assert.equal(captured.body.text.format.strict, true);
  assert.equal(result.title, draft.title);
  assert.equal(result.aiMeta.advisoryOnly, true);
  assert.equal(result.aiMeta.model, 'test-model');
  assert.equal(result.aiMeta.providerRequestId, 'resp_test_1');
  assert.deepEqual(result.aiMeta.usage, { inputTokens: 120, inputCachedTokens: 20, outputTokens: 30, reasoningTokens: 10, totalTokens: 150 });
});

test('AI task draft can use native Ollama chat with structured JSON', async () => {
  let captured;
  const draft = {
    title: 'Local AI task',
    description: 'Use a local model for AI assistance.',
    priority: 20,
    allowedPaths: ['src/ai.js'],
    verificationProfile: 'node-project',
    acceptanceCriteria: ['Ollama receives the request without an API key.'],
    risks: [],
  };
  const ai = new AIService({
    provider: 'ollama',
    apiKey: '',
    model: 'qwen2.5-coder:14b',
    fetchImpl: async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            model: 'qwen2.5-coder:14b',
            message: { role: 'assistant', content: JSON.stringify({ output: { task: draft } }) },
            prompt_eval_count: 11,
            eval_count: 7,
          };
        },
      };
    },
  });

  const result = await ai.draftTask({
    goal: 'Connect the AI helper to local AI.',
    tasks: [],
    profiles: { 'node-project': { id: 'node-project', label: 'Node' } },
    projectContext: { content: 'Prefer tiny reviewable tasks.', updatedAt: '2026-07-15T00:00:00.000Z' },
  });

  assert.equal(captured.url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(captured.init.headers.Authorization, undefined);
  assert.equal(captured.body.stream, false);
  assert.equal(captured.body.model, 'qwen2.5-coder:14b');
  assert.equal(captured.body.format.type, 'object');
  assert.equal(JSON.parse(captured.body.messages[1].content).projectContext.content, 'Prefer tiny reviewable tasks.');
  assert.equal(result.title, draft.title);
  assert.equal(result.aiMeta.serviceTier, 'local');
  assert.deepEqual(result.aiMeta.usage, { inputTokens: 11, inputCachedTokens: 0, outputTokens: 7, reasoningTokens: 0, totalTokens: 18 });
});

test('AI verification summary does not include command output by default', async () => {
  let requestBody;
  const ai = new AIService({
    apiKey: 'test-key',
    model: 'test-model',
    includeCommandOutput: false,
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return responseWith({
        verdict: 'FAIL',
        summary: '검증 실패',
        failedChecks: ['test'],
        scopeIssues: [],
        reviewerFocus: ['실패 원인 확인'],
        nextActions: ['테스트 수정'],
      });
    },
  });

  await ai.verificationSummary({
    task: {
      id: 'tsk_1',
      title: '테스트',
      description: '',
      status: 'IN_PROGRESS',
      priority: 1,
      allowedPaths: ['**'],
      verificationProfile: 'test',
      acceptanceCriteria: [],
      assigneeUserId: 'usr_a',
      reviewerUserId: 'usr_b',
      verification: {
        status: 'FAILED',
        passed: false,
        profile: 'test',
        checks: [{ file: 'node', args: ['--test'], expectedExit: 0, actualExit: 1, passed: false, timedOut: false, stdout: 'secret-output', stderr: 'secret-error' }],
      },
    },
    users: [],
  });

  assert.equal(requestBody.input.includes('secret-output'), false);
  assert.equal(requestBody.input.includes('secret-error'), false);
});

test('AI task brief receives active failure-derived skill rules', async () => {
  let requestBody;
  const ai = new AIService({
    apiKey: 'test-key',
    model: 'test-model',
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return responseWith({
        summary: '요약',
        implementationSteps: ['스킬 규칙 준수'],
        risks: [],
        reviewChecklist: ['검증 실행'],
        openQuestions: [],
      });
    },
  });

  await ai.taskBrief({
    task: {
      id: 'tsk_skill', title: '스킬 적용', description: '', status: 'IN_PROGRESS', priority: 1,
      allowedPaths: ['Game/**'], verificationProfile: 'test', skillIds: ['known-regression'],
      acceptanceCriteria: [], assigneeUserId: 'usr_a', reviewerUserId: 'usr_b',
    },
    users: [],
    skills: [{ id: 'known-regression', version: 2, label: 'Known regression', rules: ['완료 전에 node --test를 실행한다.'] }],
  });

  assert.equal(requestBody.input.includes('known-regression'), true);
  assert.equal(requestBody.input.includes('완료 전에 node --test를 실행한다.'), true);
});
