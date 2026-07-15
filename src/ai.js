import { HttpError, nowIso, sha256 } from './utils.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BOARD_TASKS = 80;

export class AIService {
  constructor({
    provider = process.env.AI_PROVIDER || 'openai-responses',
    apiKey = process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '',
    model = process.env.AI_MODEL || '',
    baseUrl = process.env.AI_BASE_URL || defaultBaseUrl(provider),
    timeoutMs = Number(process.env.AI_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    includeCommandOutput = process.env.AI_INCLUDE_COMMAND_OUTPUT === 'true',
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.provider = normalizeProvider(provider);
    this.apiKey = String(apiKey).trim();
    this.model = String(model).trim();
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this.includeCommandOutput = Boolean(includeCommandOutput);
    this.fetchImpl = fetchImpl;
  }

  status() {
    const missing = [];
    if (this.provider !== 'ollama' && !this.apiKey) missing.push('OPENAI_API_KEY');
    if (!this.model) missing.push('AI_MODEL');
    return {
      enabled: missing.length === 0,
      provider: this.provider,
      model: this.model || null,
      baseUrl: safeBaseUrl(this.baseUrl),
      includeCommandOutput: this.includeCommandOutput,
      advisoryOnly: true,
      missing,
    };
  }

  async draftTask({ goal, tasks, profiles, projectContext = null }) {
    const cleanGoal = requiredText(goal, 'Goal', 3, 4000);
    const profileIds = Object.keys(profiles ?? {});
    if (profileIds.length === 0) throw new HttpError(409, 'No verification profiles are configured.');

    const schema = taskDraftSchema(profileIds);
    const response = await this.#structured({
      name: 'team_loop_task_draft',
      schema,
      instructions: [
        'You help a small game-development team turn a human goal into one reviewable task contract.',
        'The output is advisory. Never claim the task is complete and never bypass human review or program verification.',
        'Choose only a verificationProfile from the provided list.',
        'allowedPaths must be narrow when the goal gives enough information. Use ** only when the scope is genuinely repository-wide.',
        'Write in Korean unless the supplied goal is clearly in another language.',
      ].join(' '),
      input: {
        goal: cleanGoal,
        projectContext: projectContextForAI(projectContext),
        verificationProfiles: profileIds.map((id) => ({ id, ...profiles[id] })),
        currentBoard: boardSummary(tasks),
      },
    });
    return withMeta(response.value, this.model, response.provider);
  }

  async suggestNextTasks({ objective, tasks, profiles, projectContext = null }) {
    const cleanObjective = requiredText(objective, 'Project objective', 3, 6000);
    const profileIds = Object.keys(profiles ?? {});
    if (profileIds.length === 0) throw new HttpError(409, 'No verification profiles are configured.');

    const schema = {
      type: 'object',
      properties: {
        rationale: { type: 'string', maxLength: 2000 },
        suggestions: {
          type: 'array',
          minItems: 1,
          maxItems: 5,
          items: taskDraftSchema(profileIds),
        },
      },
      required: ['rationale', 'suggestions'],
      additionalProperties: false,
    };
    const response = await this.#structured({
      name: 'team_loop_next_tasks',
      schema,
      instructions: [
        'You advise a small game-development team on the next concrete tasks.',
        'Do not duplicate work already DONE, IN_PROGRESS, REVIEW, or READY unless the new task is explicitly corrective.',
        'Prefer small tasks that one assignee can implement and another person can review.',
        'Every suggestion must have program-verifiable acceptance criteria.',
        'The output is advisory and does not create tasks.',
        'Write in Korean unless the supplied objective is clearly in another language.',
      ].join(' '),
      input: {
        objective: cleanObjective,
        projectContext: projectContextForAI(projectContext),
        verificationProfiles: profileIds.map((id) => ({ id, ...profiles[id] })),
        currentBoard: boardSummary(tasks),
      },
    });
    return withMeta(response.value, this.model, response.provider);
  }

  async taskBrief({ task, users, skills = [], projectContext = null }) {
    const response = await this.#structured({
      name: 'team_loop_task_brief',
      schema: {
        type: 'object',
        properties: {
          summary: { type: 'string', maxLength: 2000 },
          implementationSteps: stringArray(1, 10, 1000),
          risks: stringArray(0, 8, 1000),
          reviewChecklist: stringArray(1, 10, 1000),
          openQuestions: stringArray(0, 8, 1000),
        },
        required: ['summary', 'implementationSteps', 'risks', 'reviewChecklist', 'openQuestions'],
        additionalProperties: false,
      },
      instructions: [
        'Create an implementation brief for a human assignee and a separate human reviewer.',
        'Stay inside allowedPaths and the stated task contract.',
        'Applied skill rules are mandatory implementation guidance derived from prior failures. Include them in the steps and review checklist without weakening them.',
        'Do not invent source-code facts. When information is missing, put it in openQuestions.',
        'Do not mark the task complete. Program verification and the reviewer decide completion.',
        'Write in Korean.',
      ].join(' '),
      input: {
        projectContext: projectContextForAI(projectContext),
        task: taskForAI(task),
        appliedSkills: skills.map((skill) => ({ id: skill.id, version: skill.version, label: skill.label, rules: skill.rules })),
        people: publicPeople(users),
      },
    });
    return withMeta(response.value, this.model, response.provider);
  }

  async verificationSummary({ task, users, projectContext = null }) {
    if (!task.verification) throw new HttpError(409, 'Run verification before requesting an AI verification summary.');
    const verification = verificationForAI(task.verification, this.includeCommandOutput);
    const response = await this.#structured({
      name: 'team_loop_verification_summary',
      schema: {
        type: 'object',
        properties: {
          verdict: { type: 'string', enum: ['PASS', 'FAIL', 'ERROR', 'STALE'] },
          summary: { type: 'string', maxLength: 2400 },
          failedChecks: stringArray(0, 12, 1000),
          scopeIssues: stringArray(0, 12, 1000),
          reviewerFocus: stringArray(1, 10, 1000),
          nextActions: stringArray(0, 10, 1000),
        },
        required: ['verdict', 'summary', 'failedChecks', 'scopeIssues', 'reviewerFocus', 'nextActions'],
        additionalProperties: false,
      },
      instructions: [
        'Summarize machine verification evidence for a human reviewer.',
        'The machine result is the source of truth. Never change FAIL to PASS.',
        'Do not infer code quality beyond the provided evidence.',
        'Highlight scope violations, failed commands, timeouts, and stale evidence.',
        'Write in Korean.',
      ].join(' '),
      input: {
        projectContext: projectContextForAI(projectContext),
        task: taskForAI(task),
        verification,
        people: publicPeople(users),
        commandOutputIncluded: this.includeCommandOutput,
      },
    });
    return withMeta(response.value, this.model, response.provider);
  }

  async #structured({ name, schema, instructions, input }) {
    const status = this.status();
    if (!status.enabled) {
      throw new HttpError(503, `AI is not configured. Missing: ${status.missing.join(', ')}`);
    }
    if (typeof this.fetchImpl !== 'function') throw new HttpError(500, 'Fetch is unavailable for AI requests.');

    if (this.provider === 'ollama') return this.#ollamaStructured({ name, schema, instructions, input });
    if (this.provider === 'openai-chat') return this.#chatStructured({ name, schema, instructions, input });
    return this.#responsesStructured({ name, schema, instructions, input });
  }

  async #responsesStructured({ name, schema, instructions, input }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          store: false,
          instructions,
          input: JSON.stringify(input),
          text: {
            format: {
              type: 'json_schema',
              name,
              strict: true,
              schema,
            },
          },
        }),
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new HttpError(504, 'AI request timed out.');
      throw new HttpError(502, `AI request failed: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload?.error?.message || `AI provider returned HTTP ${response.status}.`;
      throw new HttpError(502, message);
    }
    const text = extractOutputText(payload);
    if (!text) throw new HttpError(502, 'AI provider returned no structured output.');
    try {
      return {
        value: parseStructuredJson(text, schema),
        provider: {
          requestId: typeof payload?.id === 'string' ? payload.id : null,
          serviceTier: typeof payload?.service_tier === 'string' ? payload.service_tier : null,
          usage: normalizeProviderUsage(payload?.usage),
        },
      };
    } catch {
      throw new HttpError(502, 'AI provider returned invalid JSON.');
    }
  }

  async #chatStructured({ name, schema, instructions, input }) {
    const payload = await this.#postJson(`${this.baseUrl}/chat/completions`, {
      model: this.model,
      temperature: 0,
      messages: [
        { role: 'system', content: `${instructions} Return only valid JSON that matches the requested schema.` },
        { role: 'user', content: JSON.stringify(input) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name, strict: true, schema },
      },
    }, authHeaders(this.apiKey));

    const text = payload?.choices?.[0]?.message?.content;
    if (!text) throw new HttpError(502, 'AI provider returned no structured output.');
    return {
      value: parseStructuredJson(text, schema),
      provider: {
        requestId: typeof payload?.id === 'string' ? payload.id : null,
        serviceTier: null,
        usage: normalizeProviderUsage(payload?.usage),
      },
    };
  }

  async #ollamaStructured({ name, schema, instructions, input }) {
    const body = {
      model: this.model,
      stream: false,
      format: schema,
      options: { temperature: 0 },
      messages: [
        { role: 'system', content: `${instructions} Return one JSON object that directly matches this JSON Schema for ${name}: ${JSON.stringify(schema)}. Do not add wrapper keys, Markdown, explanations, or examples.` },
        { role: 'user', content: JSON.stringify(input) },
      ],
    };
    let payload;
    try {
      payload = await this.#postJson(`${this.baseUrl}/api/chat`, body);
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 502) throw error;
      payload = await this.#postJson(`${this.baseUrl}/api/chat`, { ...body, format: 'json' });
    }

    const text = payload?.message?.content;
    if (!text) throw new HttpError(502, 'AI provider returned no structured output.');
    return {
      value: parseStructuredJson(text, schema),
      provider: {
        requestId: null,
        serviceTier: 'local',
        usage: normalizeOllamaUsage(payload),
      },
    };
  }

  async #postJson(url, body, headers = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        signal: controller.signal,
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new HttpError(504, 'AI request timed out.');
      throw new HttpError(502, `AI request failed: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload?.error?.message || payload?.error || `AI provider returned HTTP ${response.status}.`;
      throw new HttpError(502, message);
    }
    return payload;
  }
}

function taskDraftSchema(profileIds) {
  return {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 3, maxLength: 120 },
      description: { type: 'string', maxLength: 4000 },
      priority: { type: 'integer', minimum: 1, maximum: 999 },
      allowedPaths: {
        type: 'array',
        minItems: 1,
        maxItems: 10,
        items: { type: 'string', minLength: 1, maxLength: 300 },
      },
      verificationProfile: { type: 'string', enum: profileIds },
      acceptanceCriteria: stringArray(1, 10, 1000),
      risks: stringArray(0, 8, 1000),
    },
    required: ['title', 'description', 'priority', 'allowedPaths', 'verificationProfile', 'acceptanceCriteria', 'risks'],
    additionalProperties: false,
  };
}

function stringArray(minItems, maxItems, maxLength) {
  return {
    type: 'array',
    minItems,
    maxItems,
    items: { type: 'string', maxLength },
  };
}

function withMeta(result, model, provider = {}) {
  return {
    ...result,
    aiMeta: {
      model,
      generatedAt: nowIso(),
      advisoryOnly: true,
      contentSha256: sha256(JSON.stringify(result)),
      providerRequestId: provider.requestId ?? null,
      serviceTier: provider.serviceTier ?? null,
      usage: provider.usage ?? normalizeProviderUsage(),
    },
  };
}

export function normalizeProviderUsage(usage = {}) {
  const inputTokens = nonNegativeInteger(usage?.input_tokens);
  const inputCachedTokens = Math.min(inputTokens, nonNegativeInteger(usage?.input_tokens_details?.cached_tokens));
  const outputTokens = nonNegativeInteger(usage?.output_tokens);
  const reasoningTokens = nonNegativeInteger(usage?.output_tokens_details?.reasoning_tokens);
  const totalTokens = nonNegativeInteger(usage?.total_tokens) || inputTokens + outputTokens;
  return { inputTokens, inputCachedTokens, outputTokens, reasoningTokens, totalTokens };
}

function normalizeOllamaUsage(payload = {}) {
  const inputTokens = nonNegativeInteger(payload?.prompt_eval_count);
  const outputTokens = nonNegativeInteger(payload?.eval_count);
  return { inputTokens, inputCachedTokens: 0, outputTokens, reasoningTokens: 0, totalTokens: inputTokens + outputTokens };
}

function nonNegativeInteger(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

function boardSummary(tasks = []) {
  return tasks.slice(0, MAX_BOARD_TASKS).map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    verificationProfile: task.verificationProfile,
    allowedPaths: task.allowedPaths,
    acceptanceCriteria: task.acceptanceCriteria ?? [],
    blockedReason: task.blocked?.reason ?? null,
  }));
}

function taskForAI(task) {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    allowedPaths: task.allowedPaths,
    verificationProfile: task.verificationProfile,
    skillIds: task.skillIds ?? [],
    acceptanceCriteria: task.acceptanceCriteria ?? [],
    assigneeUserId: task.assigneeUserId,
    reviewerUserId: task.reviewerUserId,
    blockedReason: task.blocked?.reason ?? null,
  };
}

function verificationForAI(verification, includeOutput) {
  return {
    status: verification.status,
    passed: Boolean(verification.passed),
    profile: verification.profile,
    changedPaths: verification.changedPaths ?? [],
    scopeViolations: verification.scopeViolations ?? [],
    checks: (verification.checks ?? []).map((check) => ({
      file: check.file,
      args: check.args,
      expectedExit: check.expectedExit,
      actualExit: check.actualExit,
      passed: check.passed,
      timedOut: check.timedOut,
      ...(includeOutput ? {
        stdoutTail: String(check.stdout ?? '').slice(-2000),
        stderrTail: String(check.stderr ?? '').slice(-2000),
      } : {}),
    })),
  };
}

function publicPeople(users = []) {
  return users.map((user) => ({ id: user.id, name: user.name, role: user.role }));
}

function projectContextForAI(projectContext) {
  const content = String(projectContext?.content ?? '').trim();
  if (!content) return null;
  return {
    content: content.slice(0, 12_000),
    updatedAt: projectContext.updatedAt ?? null,
  };
}

function requiredText(value, label, min, max) {
  const text = String(value ?? '').trim();
  if (text.length < min || text.length > max) throw new HttpError(400, `${label} must be ${min}-${max} characters.`);
  return text;
}

function extractOutputText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  const parts = [];
  for (const item of payload?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') parts.push(content.text);
      if (content?.type === 'refusal' && typeof content.refusal === 'string') {
        throw new HttpError(422, `AI refused the request: ${content.refusal}`);
      }
    }
  }
  return parts.join('');
}

function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    const objectText = extractBalancedJsonObject(text);
    if (objectText) return JSON.parse(objectText);
    throw new HttpError(502, 'AI provider returned invalid JSON.');
  }
}

function parseStructuredJson(text, schema) {
  return normalizeStructuredValue(parseJsonText(text), schema);
}

function normalizeStructuredValue(value, schema) {
  if (matchesRequiredSchema(value, schema)) return value;
  const candidates = [];
  if (value && typeof value === 'object') {
    if (value.output && typeof value.output === 'object') candidates.push(value.output);
    for (const nested of Object.values(value.output ?? {})) {
      if (nested && typeof nested === 'object') candidates.push(nested);
    }
  }
  for (const candidate of candidates) {
    if (matchesRequiredSchema(candidate, schema)) return candidate;
  }
  return value;
}

function matchesRequiredSchema(value, schema) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const required = Array.isArray(schema?.required) ? schema.required : [];
  return required.length === 0 || required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function extractBalancedJsonObject(text) {
  const source = String(text ?? '');
  const start = source.indexOf('{');
  if (start === -1) return '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = inString;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return '';
}

function authHeaders(apiKey) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function defaultBaseUrl(provider) {
  return normalizeProvider(provider) === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.openai.com/v1';
}

function normalizeProvider(provider) {
  const value = String(provider || '').trim().toLowerCase();
  if (['ollama', 'openai-chat', 'openai-responses'].includes(value)) return value;
  return 'openai-responses';
}

function safeBaseUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return 'invalid';
  }
}
