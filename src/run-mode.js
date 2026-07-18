const MODES = new Set(['AUTO', 'CODE', 'DOCUMENT', 'BRAINSTORM']);

export function resolveRunMode(input, paths = []) {
  const rawMode = input?.mode && typeof input.mode === 'object' ? input.mode.requestedMode : input?.mode;
  const requestedMode = String(rawMode || 'AUTO').trim().toUpperCase();
  if (!MODES.has(requestedMode)) throw new Error(`Unsupported run mode: ${requestedMode}`);
  if (requestedMode !== 'AUTO') return { requestedMode, appliedMode: requestedMode, reason: 'explicit mode requested' };
  const text = [input?.title, input?.summary, input?.objective, ...paths].filter(Boolean).join(' ').toLowerCase();
  const codePaths = paths.some((item) => /(?:^|\/)(?:src|test|public|config|tools)(?:\/|$)|\.(?:js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|cs|json)$/i.test(item));
  if (codePaths) return { requestedMode, appliedMode: 'CODE', reason: 'source, test, configuration, or tooling path takes precedence' };
  if (/brainstorm|ideation|아이디어|브레인스토밍|발산|대안 탐색/.test(text) || paths.some((item) => /(?:^|\/)brainstorm(?:\/|$)/i.test(item))) {
    return { requestedMode, appliedMode: 'BRAINSTORM', reason: 'goal or path indicates divergent idea exploration' };
  }
  const documentPaths = paths.length > 0 && paths.every((item) => /(?:^docs?\/|\.(?:md|mdx|txt|rst)$)/i.test(item));
  if (documentPaths || /문서|제안서|보고서|기획서|documentation|proposal|report/.test(text)) {
    return { requestedMode, appliedMode: 'DOCUMENT', reason: 'document-oriented paths or goal detected' };
  }
  return { requestedMode, appliedMode: 'CODE', reason: 'source or mixed project work detected' };
}

export function normalizeSharedContracts(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    terms: strings(input.terms), assumptions: strings(input.assumptions),
    requiredClaims: strings(input.requiredClaims), openQuestions: strings(input.openQuestions),
  };
}
function strings(value) { return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item).trim()).filter(Boolean))].slice(0, 50); }
