import path from 'node:path';
import { HttpError } from './utils.js';

export const CONTRACT_VERSION = 1;
export const SKILL_TYPES = new Set(['procedural', 'assisted', 'executable']);
export const LOOP_PHASES = new Set(['idle', 'planning', 'running', 'reviewing', 'blocked', 'completed', 'failed']);

export function normalizeLoopDefinition(input = {}) {
  const loopId = text(input.loopId || input.projectId || input.id, 160);
  if (!loopId) throw new HttpError(400, 'Loop definition id is required.');
  const stages = (Array.isArray(input.stages) ? input.stages : input.steps || []).map((stage, index) => ({
    stageId: text(stage?.stageId || stage?.id || `stage-${index + 1}`, 100),
    label: text(stage?.label || stage?.name || stage?.stageId || stage?.id, 300),
    harnessIds: stringList(stage?.harnessIds || stage?.gates, 50, 100),
    entryCriteria: stringList(stage?.entryCriteria, 50, 500),
    exitCriteria: stringList(stage?.exitCriteria || stage?.completionCriteria, 50, 500),
  }));
  if (!stages.length || stages.some((stage) => !stage.stageId)) throw new HttpError(400, 'Loop definition needs named stages.');
  return {
    schemaVersion: CONTRACT_VERSION,
    kind: 'team-loop-definition',
    loopId,
    label: text(input.label || input.name || loopId, 300),
    objective: text(input.objective || input.description, 2000),
    stages,
    metadata: plainRecord(input.metadata),
  };
}

export function normalizeLoopState(input = {}) {
  const loopId = text(input.loopId || input.projectId, 160);
  const runId = text(input.runId || input.id, 160);
  const phase = String(input.phase || input.status || 'idle').toLowerCase();
  const errors = [];
  if (!loopId) errors.push('loopId is required.');
  if (!runId) errors.push('runId is required.');
  if (!LOOP_PHASES.has(phase)) errors.push(`Unsupported loop phase: ${phase}`);
  if (errors.length) throw new HttpError(400, 'Invalid loop state.', { errors });
  return {
    schemaVersion: CONTRACT_VERSION,
    kind: 'team-loop-state',
    loopId,
    runId,
    phase,
    stageId: text(input.stageId || input.currentStage, 100) || null,
    iteration: nonNegativeInteger(input.iteration, 0),
    updatedAt: isoDate(input.updatedAt) || null,
    blockers: stringList(input.blockers, 100, 1000),
    metadata: plainRecord(input.metadata),
  };
}

export function normalizeBalanceSpec(input = {}) {
  const balanceId = text(input.balanceId || input.id, 160);
  if (!balanceId) throw new HttpError(400, 'Balance spec id is required.');
  const parameters = normalizeNamedNumbers(input.parameters || input.variables);
  const parameterSpace = (Array.isArray(input.parameterSpace) ? input.parameterSpace : []).map((item) => ({
    parameterId: text(item?.parameterId || item?.id || item?.path, 160),
    path: safePath(String(item?.path || '').replaceAll('.', '/')),
    minimum: finiteNumber(item?.minimum ?? item?.min),
    maximum: finiteNumber(item?.maximum ?? item?.max),
    step: finiteNumber(item?.step),
  }));
  const metrics = normalizeMetrics(input.metrics || input.measurements);
  if (!Object.keys(parameters).length) throw new HttpError(400, 'Balance spec needs at least one parameter.');
  if (!metrics.length) throw new HttpError(400, 'Balance spec needs at least one metric.');
  if (parameterSpace.some((item) => !item.parameterId || !item.path || item.minimum === null || item.maximum === null || item.step === null || item.step <= 0 || item.minimum > item.maximum)) {
    throw new HttpError(400, 'Balance parameterSpace entries need a safe path and valid minimum, maximum, and positive step.');
  }
  return {
    schemaVersion: CONTRACT_VERSION,
    kind: 'team-loop-balance-spec',
    balanceId,
    objective: text(input.objective || input.description, 2000),
    parameters,
    parameterSpace,
    metrics,
    constraints: stringList(input.constraints, 100, 1000),
    search: {
      deterministic: input.search?.deterministic !== false,
      seed: text(input.search?.seed, 160) || null,
      strategy: text(input.search?.strategy || 'explicit-grid', 100),
    },
    simulation: {
      horizon: nonNegativeInteger(input.simulation?.horizon, 1),
      runsPerSeed: nonNegativeInteger(input.simulation?.runsPerSeed, 1),
      seeds: [...new Set((Array.isArray(input.simulation?.seeds) ? input.simulation.seeds : [])
        .map(Number).filter(Number.isFinite))].slice(0, 50),
      policies: stringList(input.simulation?.policies, 50, 160),
    },
  };
}

export function normalizeObservationSet(input = {}) {
  const observationSetId = text(input.observationSetId || input.measurementId || input.id, 160);
  const balanceId = text(input.balanceId || input.specId, 160);
  if (!observationSetId || !balanceId) throw new HttpError(400, 'Observation set needs observationSetId and balanceId.');
  const observations = (Array.isArray(input.observations) ? input.observations : input.rows || []).map((item, index) => ({
    observationId: text(item?.observationId || item?.id || `observation-${index + 1}`, 160),
    iteration: nonNegativeInteger(item?.iteration, index),
    inputs: normalizeNamedNumbers(item?.inputs || item?.parameters),
    outputs: normalizeNamedNumbers(item?.outputs || item?.metrics),
    passed: typeof item?.passed === 'boolean' ? item.passed : null,
    evidence: stringList(item?.evidence, 50, 1000),
  }));
  if (!observations.length) throw new HttpError(400, 'Observation set needs observations.');
  return {
    schemaVersion: CONTRACT_VERSION,
    kind: 'team-loop-observation-set',
    observationSetId,
    balanceId,
    capturedAt: isoDate(input.capturedAt || input.createdAt) || null,
    observations,
  };
}

export function normalizeExperienceEvent(input = {}) {
  const eventId = text(input.eventId || input.id, 160);
  const eventType = text(input.eventType || input.type, 100).toLowerCase();
  if (!eventId || !eventType) throw new HttpError(400, 'Experience event needs eventId and eventType.');
  return {
    schemaVersion: CONTRACT_VERSION,
    kind: 'team-loop-experience-event',
    eventId,
    eventType,
    occurredAt: isoDate(input.occurredAt || input.createdAt) || null,
    loopId: text(input.loopId || input.projectId, 160) || null,
    runId: text(input.runId, 160) || null,
    actor: text(input.actor || input.agentId || 'unknown', 160),
    summary: text(input.summary || input.lesson || input.message, 4000),
    evidence: stringList(input.evidence || input.artifacts, 100, 2000),
    outcome: text(input.outcome || input.status, 100) || null,
    metadata: plainRecord(input.metadata),
  };
}

export function normalizeContextPackContract(input = {}) {
  const packId = text(input.packId || input.diId || input.id, 160);
  if (!packId) throw new HttpError(400, 'Context pack id is required.');
  const requiredInputs = uniqueBy((Array.isArray(input.requiredInputs) ? input.requiredInputs : []).map((item) => ({
    path: safePath(item?.path),
    sha256: hash(item?.sha256),
    sectionIds: stringList(item?.sectionIds, 50, 160),
  })), (item) => item.path);
  const readOrder = uniquePaths(input.readOrder);
  const writeScope = uniquePaths(input.writeScope ?? input.allowlist);
  const forbiddenActions = stringList(input.forbiddenActions, 50, 200);
  const errors = [];
  if (requiredInputs.some((item) => !item.path || !item.sha256)) errors.push('requiredInputs entries need path and sha256.');
  const missingReadOrder = requiredInputs.map((item) => item.path).filter((item) => !readOrder.includes(item));
  if (missingReadOrder.length) errors.push(`requiredInputs missing from readOrder: ${missingReadOrder.join(', ')}`);
  const overlap = requiredInputs.map((item) => item.path).filter((item) => scopesOverlapPath(item, writeScope));
  if (overlap.length) errors.push(`requiredInputs overlap writeScope: ${overlap.join(', ')}`);
  if (errors.length) throw new HttpError(400, 'Invalid context pack contract.', { errors });
  return {
    schemaVersion: CONTRACT_VERSION,
    kind: 'team-loop-context-pack',
    packId,
    requiredInputs,
    readOrder,
    writeScope,
    forbiddenActions,
  };
}

export function normalizeSkillManifest(input = {}, defaults = {}) {
  const skillType = String(input.skillType || defaults.skillType || 'assisted').toLowerCase();
  const automationLevel = Number(input.automationLevel ?? defaults.automationLevel ?? 5);
  const humanApprovalPoints = stringList(input.humanApprovalPoints ?? defaults.humanApprovalPoints, 30, 500);
  const sideEffectScope = uniquePaths(input.sideEffectScope ?? defaults.sideEffectScope);
  const requiredCapabilities = stringList(input.requiredCapabilities ?? defaults.requiredCapabilities, 30, 500);
  const errors = [];
  if (!SKILL_TYPES.has(skillType)) errors.push('skillType must be procedural, assisted, or executable.');
  if (!Number.isInteger(automationLevel) || automationLevel < 0 || automationLevel > 10) errors.push('automationLevel must be an integer from 0 to 10.');
  if (skillType !== 'executable' && humanApprovalPoints.length === 0) errors.push(`${skillType} skills require a human approval point.`);
  if (skillType === 'executable' && automationLevel < 7) errors.push('executable skills require automationLevel 7 or higher.');
  if (errors.length) throw new HttpError(400, 'Invalid skill manifest.', { errors });
  return {
    schemaVersion: CONTRACT_VERSION,
    skillType,
    automationLevel,
    humanApprovalPoints,
    sideEffectScope,
    requiredCapabilities,
  };
}

export function inferSkillManifest(skill = {}) {
  const failureDerived = skill.source === 'FAILURE_DERIVED';
  return normalizeSkillManifest(skill.manifest || {}, {
    skillType: 'assisted',
    automationLevel: failureDerived ? 6 : 5,
    humanApprovalPoints: ['Review the skill outcome before promoting durable knowledge or changing shared policy.'],
    sideEffectScope: [],
    requiredCapabilities: ['Read the selected context pack and report the observed outcome.'],
  });
}

export function normalizeHarnessContract(input = {}) {
  const harnessId = text(input.harnessId || input.id, 100);
  if (!harnessId) throw new HttpError(400, 'Harness id is required.');
  const source = Array.isArray(input.checks) ? input.checks : input.commands;
  if (!Array.isArray(source) || source.length === 0) throw new HttpError(400, 'Harness needs at least one check.');
  const checks = source.map((check, index) => ({
    order: Number.isInteger(check.order) ? check.order : index + 1,
    command: text(check.command || check.file, 300),
    args: stringList(check.args, 100, 2000),
    expectedExit: Number.isInteger(check.expectedExit) ? check.expectedExit : 0,
    mutatesState: Boolean(check.mutatesState),
    cwd: safePath(check.cwd || '.') || '.',
    timeoutMs: Number.isFinite(Number(check.timeoutMs)) ? Number(check.timeoutMs) : 120_000,
  })).sort((a, b) => a.order - b.order);
  if (checks.some((check) => !check.command)) throw new HttpError(400, 'Harness check command is required.');
  if (new Set(checks.map((check) => check.order)).size !== checks.length) throw new HttpError(400, 'Harness check order must be unique.');
  return {
    schemaVersion: CONTRACT_VERSION,
    kind: 'team-loop-harness',
    harnessId,
    description: text(input.description, 2000),
    checks,
  };
}

export function normalizeGateManifest(input = {}) {
  const gates = (Array.isArray(input.gates) ? input.gates : []).map((gate) => ({
    gateId: text(gate.gateId, 100),
    description: text(gate.description, 2000),
    triggeredBy: text(gate.triggeredBy, 500),
    checks: (Array.isArray(gate.checks) ? gate.checks : []).map((check, index) => ({
      order: Number.isInteger(check.order) ? check.order : index + 1,
      harnessId: text(check.harnessId || check.command, 100),
      args: stringList(check.args, 100, 2000),
      expectedExit: Number.isInteger(check.expectedExit) ? check.expectedExit : 0,
      mutatesState: Boolean(check.mutatesState),
      note: text(check.note, 1000),
    })).sort((a, b) => a.order - b.order),
  }));
  if (!gates.length || gates.some((gate) => !gate.gateId || !gate.checks.length)) throw new HttpError(400, 'Gate manifest needs named gates with checks.');
  return { schemaVersion: CONTRACT_VERSION, kind: 'team-loop-gate-manifest', gates };
}

export const KNOWLEDGE_PROMOTION_CONTRACT = Object.freeze({
  schemaVersion: CONTRACT_VERSION,
  kind: 'team-loop-knowledge-promotion',
  minimumOccurrences: 2,
  priority: ['HARNESS', 'SKILL', 'WIKI'],
  scoring: {
    dimensions: ['repeatability', 'decidability', 'failureInjection', 'isolation', 'observability', 'maintenanceValue'],
    minimum: 0,
    maximum: 2,
    thresholds: { rejectMax: 4, holdMax: 7, extendMax: 10, createMin: 11 },
  },
  requiresEvidence: true,
  automaticPromotion: false,
});

function safePath(value) {
  const normalized = String(value ?? '').trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized === '.') return normalized;
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new HttpError(400, `Unsafe contract path: ${value}`);
  }
  return normalized;
}

function uniquePaths(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(safePath).filter(Boolean))].slice(0, 200);
}

function scopesOverlapPath(target, scopes) {
  return scopes.some((scope) => {
    const prefix = scope.replace(/\*.*$/, '').replace(/\/+$/, '');
    return scope === '**' || target === scope || (prefix && (target === prefix || target.startsWith(`${prefix}/`)));
  });
}

function hash(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : '';
}

function text(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function stringList(value, maxItems, maxLength) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => text(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function uniqueBy(items, key) {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}

function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 200));
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function isoDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function normalizeNamedNumbers(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = Object.entries(value).slice(0, 200).map(([key, raw]) => {
    const name = text(key, 160);
    const candidate = raw && typeof raw === 'object' ? raw.value : raw;
    const number = Number(candidate);
    if (!name || !Number.isFinite(number)) throw new HttpError(400, `Invalid numeric value for ${key}.`);
    return [name, number];
  });
  return Object.fromEntries(entries);
}

function normalizeMetrics(value) {
  if (Array.isArray(value)) {
    return value.map((metric) => ({
      metricId: text(metric?.metricId || metric?.id || metric?.name, 160),
      target: Number.isFinite(Number(metric?.target)) ? Number(metric.target) : null,
      minimum: Number.isFinite(Number(metric?.minimum ?? metric?.min)) ? Number(metric.minimum ?? metric.min) : null,
      maximum: Number.isFinite(Number(metric?.maximum ?? metric?.max)) ? Number(metric.maximum ?? metric.max) : null,
      weight: Number.isFinite(Number(metric?.weight)) ? Number(metric.weight) : 1,
    })).filter((metric) => metric.metricId);
  }
  return Object.entries(value && typeof value === 'object' ? value : {}).map(([metricId, metric]) => ({
    metricId: text(metricId, 160),
    target: Number.isFinite(Number(metric?.target ?? metric)) ? Number(metric?.target ?? metric) : null,
    minimum: Number.isFinite(Number(metric?.minimum ?? metric?.min)) ? Number(metric.minimum ?? metric.min) : null,
    maximum: Number.isFinite(Number(metric?.maximum ?? metric?.max)) ? Number(metric.maximum ?? metric.max) : null,
    weight: Number.isFinite(Number(metric?.weight)) ? Number(metric.weight) : 1,
  }));
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
