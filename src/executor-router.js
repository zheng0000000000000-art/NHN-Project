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
  const available = policy.executors.filter((item) => item.enabled && (remoteAllowed || item.tier !== 'remote'));
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

function normalizeCandidate(value) {
  if (!value || typeof value !== 'object') return null;
  const id = String(value.id || '').trim().slice(0, 80);
  const tool = String(value.tool || '').trim();
  const tier = String(value.tier || 'local').trim().toLowerCase();
  if (!id || !EXECUTOR_TOOLS.includes(tool) || !['local', 'remote'].includes(tier)) return null;
  return {
    id, tool, tier,
    model: String(value.model || '').trim().slice(0, 120),
    enabled: value.enabled !== false,
    weight: boundedNumber(value.weight, 50, 0, 100),
  };
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}
