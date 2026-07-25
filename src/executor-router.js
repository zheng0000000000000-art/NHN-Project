import { EXECUTOR_TOOLS } from './executor.js';

export function normalizeWorkerConfig(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const routing = source.routing && typeof source.routing === 'object' ? source.routing : {};
  const executors = Array.isArray(source.executors) && source.executors.length
    ? source.executors
    : source.executor?.tool
      ? [{ id: 'legacy-default', ...source.executor, tier: 'remote', weight: 50 }]
      : [];
  return {
    strategy: routing.strategy === 'remote-first' ? 'remote-first' : 'local-first',
    allowRemote: routing.allowRemote !== false,
    remoteEscalationPriority: boundedNumber(routing.remoteEscalationPriority, 80, 0, 100),
    executors: executors.map(normalizeCandidate).filter(Boolean),
  };
}

export function selectExecutor(task, config, { quality = 'auto', allowRemote, executorId = '' } = {}) {
  const policy = normalizeWorkerConfig(config);
  const remoteAllowed = allowRemote ?? policy.allowRemote;
  const available = policy.executors.filter((item) => item.enabled && item.roles.includes('execute') && (remoteAllowed || item.tier !== 'remote'));
  if (!available.length) return { executor: null, reason: 'NO_EXECUTOR' };
  if (executorId) {
    const candidate = available.find((item) => item.id === executorId);
    if (!candidate) return { executor: null, reason: 'EXECUTOR_NOT_AVAILABLE' };
    return {
      executor: { tool: candidate.tool, ...(candidate.model ? { model: candidate.model } : {}) },
      candidate,
      reason: 'USER_SELECTED',
    };
  }
  const wantsRemote = quality === 'high'
    || (quality === 'auto' && Number(task?.priority || 0) >= policy.remoteEscalationPriority);
  const tierOrder = quality === 'local' || !remoteAllowed
    ? ['local']
    : wantsRemote || policy.strategy === 'remote-first' ? ['remote', 'local'] : ['local', 'remote'];
  for (const tier of tierOrder) {
    const candidate = available.filter((item) => item.tier === tier)
      .sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id))[0];
    if (candidate) return {
      executor: { tool: candidate.tool, ...(candidate.model ? { model: candidate.model } : {}) },
      candidate,
      reason: tier === 'remote' ? (wantsRemote ? 'QUALITY_ESCALATION' : 'REMOTE_FALLBACK') : 'LOCAL_FIRST',
    };
  }
  return { executor: null, reason: remoteAllowed ? 'NO_EXECUTOR' : 'NO_LOCAL_EXECUTOR' };
}

export function selectReviewer(task, config, { quality = 'high', allowRemote, reviewerProfileId = '', executorProfileId = '' } = {}) {
  const policy = normalizeWorkerConfig(config);
  const remoteAllowed = allowRemote ?? policy.allowRemote;
  const available = policy.executors.filter((item) =>
    item.enabled && item.roles.includes('review') && (remoteAllowed || item.tier !== 'remote'));
  if (!available.length) return { reviewer: null, candidate: null, reason: 'NO_REVIEWER' };
  if (reviewerProfileId) {
    const candidate = available.find((item) => item.id === reviewerProfileId);
    if (!candidate) return { reviewer: null, candidate: null, reason: 'REVIEWER_NOT_AVAILABLE' };
    return {
      reviewer: { tool: candidate.tool, ...(candidate.model ? { model: candidate.model } : {}) },
      candidate,
      reason: 'USER_SELECTED',
      independent: candidate.id !== executorProfileId,
    };
  }
  const ranked = [...available].sort((a, b) =>
    Number(a.id === executorProfileId) - Number(b.id === executorProfileId)
    || b.quality - a.quality
    || b.weight - a.weight
    || a.id.localeCompare(b.id));
  const candidate = ranked[0];
  return {
    reviewer: { tool: candidate.tool, ...(candidate.model ? { model: candidate.model } : {}) },
    candidate,
    reason: candidate.id === executorProfileId ? 'SAME_PROFILE_FALLBACK' : 'INDEPENDENT_REVIEW',
    independent: candidate.id !== executorProfileId,
  };
}

function normalizeCandidate(value) {
  if (!value || typeof value !== 'object') return null;
  const id = String(value.id || '').trim().slice(0, 80);
  const tool = String(value.tool || '').trim();
  const tier = String(value.tier || 'local').trim().toLowerCase();
  if (!id || !EXECUTOR_TOOLS.includes(tool) || !['local', 'remote'].includes(tier)) return null;
  return {
    id, tool, tier,
    label: String(value.label || id).trim().slice(0, 120),
    model: String(value.model || '').trim().slice(0, 120),
    enabled: value.enabled !== false,
    weight: boundedNumber(value.weight, 50, 0, 100),
    quality: boundedNumber(value.quality, tier === 'remote' ? 80 : 50, 0, 100),
    roles: normalizeRoles(value.roles),
  };
}

function normalizeRoles(value) {
  const roles = Array.isArray(value) ? value.map((item) => String(item).toLowerCase()) : ['execute', 'review'];
  const valid = [...new Set(roles.filter((item) => ['execute', 'review'].includes(item)))];
  return valid.length ? valid : ['execute', 'review'];
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}
