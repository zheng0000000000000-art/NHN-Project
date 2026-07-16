const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'task', 'test', 'check', 'file', 'files',
  'code', 'work', 'update', 'change', 'create', 'add', 'fix', '기능', '작업', '수정', '추가', '확인',
  '검증', '완료', '조건', '파일', '코드',
]);

export function selectLearningForTask(input, { activeHarnesses = [], activeSkills = [], defaultProfile = null } = {}) {
  const task = taskDescriptor(input);
  const harness = selectHarness(task, activeHarnesses, defaultProfile);
  const skills = selectSkills(task, activeSkills);
  return {
    verificationProfile: harness?.id || defaultProfile || null,
    skillIds: skills.map((item) => item.id),
    rationale: {
      harness: harness ? { id: harness.id, score: harness.score, reason: harness.reason } : null,
      skills: skills.map((item) => ({ id: item.id, score: item.score, reason: item.reason })),
    },
  };
}

function selectHarness(task, activeHarnesses, defaultProfile) {
  const scored = activeHarnesses
    .map((harness) => ({ ...harness, ...scoreArtifact(task, harnessText(harness), harnessPathText(harness)) }))
    .filter((item) => item.score >= 4)
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
  if (scored.length) return scored[0];
  const fallback = activeHarnesses.find((item) => item.id === defaultProfile);
  return fallback ? { ...fallback, score: 0, reason: 'default profile fallback' } : null;
}

function selectSkills(task, activeSkills) {
  return activeSkills
    .map((skill) => ({ ...skill, ...scoreArtifact(task, skillText(skill), '') }))
    .filter((item) => item.score >= 2)
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)))
    .slice(0, 8);
}

function scoreArtifact(task, artifactText, artifactPathText) {
  const artifactTokens = tokenize(artifactText);
  const overlaps = [...task.tokens].filter((token) => artifactTokens.has(token));
  let score = overlaps.length;
  const reasons = [];
  if (overlaps.length) reasons.push(`keyword overlap: ${overlaps.slice(0, 5).join(', ')}`);

  for (const pathToken of task.pathTokens) {
    if (artifactTokens.has(pathToken)) {
      score += 2;
      reasons.push(`path token: ${pathToken}`);
      break;
    }
  }

  for (const pathValue of task.pathValues) {
    if (pathValue.length >= 4 && artifactPathText.includes(pathValue)) {
      score += 5;
      reasons.push(`path match: ${pathValue}`);
      break;
    }
  }

  return { score, reason: reasons.join('; ') || 'no local match' };
}

function taskDescriptor(input) {
  const allowedPaths = Array.isArray(input.allowedPaths) ? input.allowedPaths : [];
  const criteria = Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria : [];
  const text = [
    input.title,
    input.description,
    ...criteria,
    ...allowedPaths,
  ].filter(Boolean).join('\n');
  return {
    tokens: tokenize(text),
    pathTokens: tokenize(allowedPaths.join('/')),
    pathValues: allowedPaths.map(normalizePathSignal).filter(Boolean),
  };
}

function harnessText(harness) {
  return [
    harness.id,
    harness.label,
    harness.description,
    harness.source,
    ...(harness.sourceFailureCaseIds || []),
    ...(harness.commands || []).flatMap((command) => [command.file, command.cwd, ...(command.args || [])]),
  ].filter(Boolean).join('\n');
}

function harnessPathText(harness) {
  return (harness.commands || [])
    .flatMap((command) => [command.file, command.cwd, ...(command.args || [])])
    .map(normalizePathSignal)
    .filter(Boolean)
    .join('\n');
}

function skillText(skill) {
  return [
    skill.id,
    skill.label,
    skill.description,
    skill.source,
    ...(skill.rules || []),
    ...(skill.sourceFailureCaseIds || []),
  ].filter(Boolean).join('\n');
}

function tokenize(value) {
  const tokens = String(value || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && !STOP_WORDS.has(item));
  return new Set(tokens);
}

function normalizePathSignal(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/^\.?\//, '')
    .replace(/\/+$/g, '')
    .trim();
}
