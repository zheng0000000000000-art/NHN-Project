import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson, atomicWriteText, nowIso, readJson, sha256 } from './utils.js';

const REQUIRED_DECISIONS = ['YES', 'NO', 'ASK', 'BLOCKED'];
const REQUIRED_LIFECYCLE = ['ENTER', 'PLAN', 'EXECUTE', 'VERIFY', 'LEARN', 'HANDOFF', 'CLOSE'];

export class ConstitutionCompiler {
  constructor({ sourcePath, outputDirectory }) {
    this.sourcePath = path.resolve(sourcePath);
    this.outputDirectory = path.resolve(outputDirectory);
    this.compiled = null;
  }

  async compile() {
    const source = await readFile(this.sourcePath, 'utf8');
    const summary = extractMachineSummary(source);
    validateSummary(summary);
    const compiledAt = nowIso();
    const sourceSha256 = sha256(source);
    const policy = {
      schemaVersion: 1,
      kind: 'team-loop-orchestration-policy',
      constitutionVersion: summary.constitutionVersion,
      constitutionStatus: summary.status,
      sourceSha256,
      compiledAt,
      entryOrder: summary.entryOrder,
      decisions: summary.decisions,
      defaultExecution: summary.defaultExecution,
      automaticConditions: summary.automaticConditions,
      approvalConditions: summary.approvalConditions,
      startProtocol: summary.startProtocol,
      workLifecycle: summary.workLifecycle,
      defaultReadBudgetTokens: summary.defaultReadBudgetTokens,
      writeFactsOnlyHandoffImmediately: summary.writeFactsOnlyHandoffImmediately,
      requireVerificationBeforeCompletion: summary.requireVerificationBeforeCompletion,
      showConstitutionVersionOnMajorSurfaces: summary.showConstitutionVersionOnMajorSurfaces,
      decisionTable: summary.decisionTable,
      acceptanceScenarios: summary.acceptanceScenarios,
    };
    const instructions = buildInstructions(policy);
    const scenarios = buildScenarios(policy);
    await Promise.all([
      atomicWriteJson(path.join(this.outputDirectory, 'orchestration-policy.json'), policy),
      atomicWriteText(path.join(this.outputDirectory, 'mcp-instructions.txt'), `${instructions}\n`),
      atomicWriteJson(path.join(this.outputDirectory, 'acceptance-scenarios.json'), scenarios),
    ]);
    this.compiled = { policy, instructions, scenarios };
    return this.status();
  }

  status() {
    if (!this.compiled) return null;
    const { policy } = this.compiled;
    return {
      constitutionVersion: policy.constitutionVersion,
      constitutionStatus: policy.constitutionStatus,
      sourceSha256: policy.sourceSha256,
      compiledAt: policy.compiledAt,
      decisions: policy.decisions,
      lifecycle: policy.workLifecycle,
    };
  }

  policy() {
    if (!this.compiled) throw new Error('Constitution has not been compiled.');
    return structuredClone(this.compiled.policy);
  }

  instructions() {
    if (!this.compiled) throw new Error('Constitution has not been compiled.');
    return this.compiled.instructions;
  }
}

export class ConstitutionObservationStore {
  constructor(dataDirectory) {
    this.path = path.join(dataDirectory, 'constitution-observations.json');
    this.lock = Promise.resolve();
  }

  async initialize() {
    await this.#withLock(async () => {
      const db = await readJson(this.path, { schemaVersion: 1, observations: [] });
      if (!Array.isArray(db.observations)) throw new Error('Invalid constitution observation ledger.');
      await atomicWriteJson(this.path, db);
    });
  }

  async record(actor, decision) {
    const observation = {
      id: `obs_${sha256(`${actor.id}:${decision.decidedAt}:${decision.reasonCode}`).slice(0, 20)}`,
      constitutionVersion: decision.constitutionVersion,
      constitutionStatus: decision.constitutionStatus,
      actorUserId: actor.id,
      decision: decision.decision,
      reasonCode: decision.reasonCode,
      action: decision.action?.name || null,
      latencyMs: Number(decision.latencyMs || 0),
      successful: decision.decision !== 'BLOCKED',
      observedAt: decision.decidedAt,
    };
    return this.#withLock(async () => {
      const db = await readJson(this.path, { schemaVersion: 1, observations: [] });
      db.observations.unshift(observation);
      db.observations = db.observations.slice(0, 2_000);
      await atomicWriteJson(this.path, db);
      return observation;
    });
  }

  async audit(constitutionVersion, { limit = 50 } = {}) {
    const db = await readJson(this.path, { schemaVersion: 1, observations: [] });
    const matching = db.observations.filter((item) => item.constitutionVersion === constitutionVersion);
    const latencies = matching.map((item) => item.latencyMs).sort((a, b) => a - b);
    return {
      schemaVersion: 1,
      constitutionVersion,
      observations: matching.length,
      successful: matching.filter((item) => item.successful).length,
      blocked: matching.filter((item) => !item.successful).length,
      decisions: countBy(matching, 'decision'),
      reasonCodes: countBy(matching, 'reasonCode'),
      latencyMs: {
        median: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        max: latencies.at(-1) || 0,
        budget: 300,
        withinBudget: latencies.length === 0 || (latencies.at(-1) || 0) <= 300,
      },
      recent: matching.slice(0, Math.max(1, Math.min(200, Number(limit) || 50))),
    };
  }

  #withLock(work) {
    const result = this.lock.then(work, work);
    this.lock = result.catch(() => {});
    return result;
  }
}

export async function compileConstitutionInMemory(sourcePath) {
  const source = await readFile(sourcePath, 'utf8');
  const summary = extractMachineSummary(source);
  validateSummary(summary);
  const policy = {
    ...summary,
    kind: 'team-loop-orchestration-policy',
    constitutionStatus: summary.status,
    sourceSha256: sha256(source),
    decisionTable: summary.decisionTable,
    acceptanceScenarios: summary.acceptanceScenarios,
  };
  return { policy, instructions: buildInstructions(policy), scenarios: buildScenarios(policy) };
}

export function extractMachineSummary(source) {
  const section = String(source).match(/## 16\. Machine-readable summary[\s\S]*?```json\s*([\s\S]*?)\s*```/);
  if (!section) throw new TypeError('Constitution machine-readable summary was not found.');
  try {
    return JSON.parse(section[1]);
  } catch (error) {
    throw new TypeError(`Constitution machine-readable summary is invalid JSON: ${error.message}`);
  }
}

export function validateSummary(value) {
  if (value?.schemaVersion !== 1) throw new TypeError('Unsupported constitution schema version.');
  if (!/^\d+\.\d+\.\d+$/.test(String(value.constitutionVersion || ''))) throw new TypeError('Constitution version must use semver.');
  if (!['DRAFT', 'PROBATION', 'ACTIVE'].includes(value.status)) throw new TypeError('Invalid constitution status.');
  if (JSON.stringify(value.decisions) !== JSON.stringify(REQUIRED_DECISIONS)) throw new TypeError('Constitution decisions must be YES, NO, ASK, BLOCKED in order.');
  if (JSON.stringify(value.workLifecycle) !== JSON.stringify(REQUIRED_LIFECYCLE)) throw new TypeError('Constitution work lifecycle is incomplete.');
  if (!Array.isArray(value.entryOrder) || value.entryOrder.length < 4) throw new TypeError('Constitution entry order is incomplete.');
  if (!Array.isArray(value.automaticConditions) || !value.automaticConditions.length) throw new TypeError('Automatic execution conditions are required.');
  if (!Array.isArray(value.approvalConditions) || !value.approvalConditions.length) throw new TypeError('Approval conditions are required.');
  if (!value.startProtocol || !Array.isArray(value.startProtocol.selection) || !Array.isArray(value.startProtocol.requirements)) {
    throw new TypeError('Canonical work start protocol is required.');
  }
  if (!Array.isArray(value.decisionTable) || !value.decisionTable.length) throw new TypeError('Constitution decision table is required.');
  const reasonCodes = new Set();
  for (const rule of value.decisionTable) {
    if (!rule?.reasonCode || reasonCodes.has(rule.reasonCode)) throw new TypeError('Constitution decision reason codes must be unique.');
    if (!REQUIRED_DECISIONS.includes(rule.decision)) throw new TypeError(`Invalid decision for ${rule.reasonCode}.`);
    if (!rule.action || !Number.isFinite(Number(rule.priority))) throw new TypeError(`Invalid action rule for ${rule.reasonCode}.`);
    reasonCodes.add(rule.reasonCode);
  }
  if (!Array.isArray(value.acceptanceScenarios) || !value.acceptanceScenarios.length) throw new TypeError('Constitution acceptance scenarios are required.');
  for (const scenario of value.acceptanceScenarios) {
    const rule = value.decisionTable.find((item) => item.action === scenario.expectedAction && item.decision === scenario.expectedDecision);
    if (!scenario?.id || !rule) throw new TypeError(`Acceptance scenario ${scenario?.id || '(missing id)'} does not match the decision table.`);
  }
  if (!Number.isInteger(value.defaultReadBudgetTokens) || value.defaultReadBudgetTokens < 1000) throw new TypeError('Default read budget is invalid.');
  return value;
}

function buildInstructions(policy) {
  return [
    `Team Loop constitution ${policy.constitutionVersion} (${policy.constitutionStatus}) governs this server.`,
    'The user states desired outcomes; do not require them to know Team Loop menus or tool names.',
    'Begin an unexplained session with loop_enter. Follow its decision, reasonCode, readPlan, and single recommended action.',
    'Use only the current project context by default. Search archived documentation only through context_archive_search.',
    `Automatically act only when all applicable conditions are safe: ${policy.automaticConditions.join(', ')}.`,
    `Ask before: ${policy.approvalConditions.join(', ')}.`,
    `Start or resume work through the shared start protocol: ${policy.startProtocol.selection.join(' -> ')}; require ${policy.startProtocol.requirements.join(', ')}.`,
    'After creating a multi-step plan, call work_start_next when the first READY task is safe. Do not ask the user to press a start button.',
    `Complete meaningful work through: ${policy.workLifecycle.join(' -> ')}.`,
    'Program facts and verification evidence outrank AI summaries. Write or preserve a HANDOFF before ending resumable work.',
  ].join('\n');
}

function buildScenarios(policy) {
  return {
    schemaVersion: 1,
    constitutionVersion: policy.constitutionVersion,
    scenarios: policy.acceptanceScenarios,
  };
}

function countBy(items, key) {
  return Object.fromEntries([...items.reduce((counts, item) => {
    const value = String(item[key] || 'UNKNOWN');
    counts.set(value, (counts.get(value) || 0) + 1);
    return counts;
  }, new Map()).entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1))];
}
