// Per-user CLI executor profile.
//
// A person configures their local CLI (`team-loop config set ...`) with the tool
// and model they work with, plus optional default harness/skills. When they claim a
// task, the CLI sends this profile and the server records it on the task so the board
// shows which CLI picked the work up. The record is informational: nothing is enforced.

export const EXECUTOR_TOOLS = ['claude-code', 'codex', 'custom'];

function clip(value, max) {
  if (value == null) return null;
  const text = String(value).trim().slice(0, max);
  return text.length ? text : null;
}

// Validate and normalize an executor object received from a CLI claim request.
// Returns null when the input carries no usable fields (so the claim leaves any
// existing executor untouched). Throws an Error with statusCode 400 on bad shapes.
export function sanitizeExecutorInput(value, { actorUserId = null, at = new Date().toISOString() } = {}) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error('executor must be an object.');
    error.statusCode = 400;
    throw error;
  }
  const tool = clip(value.tool, 40);
  const model = clip(value.model, 80);
  const harness = clip(value.harness, 80);
  const skills = Array.isArray(value.skills)
    ? [...new Set(value.skills.map((item) => String(item).trim().slice(0, 80)).filter(Boolean))].slice(0, 20)
    : [];
  if (!tool && !model && !harness && skills.length === 0) return null;
  return { tool, model, harness, skills, setByUserId: actorUserId, setAt: at };
}

// Build the executor payload a CLI sends on claim from its saved config.json.
// Merges the executor block (tool/model) with the defaults block (harness/skills).
export function mergeCliExecutor(config) {
  if (!config || typeof config !== 'object') return null;
  const executor = config.executor && typeof config.executor === 'object' ? config.executor : {};
  const defaults = config.defaults && typeof config.defaults === 'object' ? config.defaults : {};
  const out = {};
  if (executor.tool) out.tool = String(executor.tool);
  if (executor.model) out.model = String(executor.model);
  if (defaults.harness) out.harness = String(defaults.harness);
  if (Array.isArray(defaults.skills) && defaults.skills.length) {
    out.skills = defaults.skills.map((item) => String(item));
  }
  return Object.keys(out).length ? out : null;
}
