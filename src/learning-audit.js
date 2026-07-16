const REVIEW_ONLY = 'REVIEW_ONLY';
const KEEP = 'KEEP';
const CONDITIONAL = 'CONDITIONAL';
const CLEANUP = 'CLEANUP';

export function auditLearningArtifacts({ harnesses = [], skills = [] } = {}) {
  const harnessFindings = auditHarnesses(harnesses);
  const skillFindings = auditSkills(skills);
  return {
    generatedAt: new Date().toISOString(),
    harnesses: harnessFindings,
    skills: skillFindings,
    summary: summarize([...harnessFindings, ...skillFindings]),
    actions: cleanupActions(harnessFindings, skillFindings),
  };
}

function auditHarnesses(harnesses) {
  const byCommand = new Map();
  for (const harness of harnesses) {
    const key = harnessCommandKey(harness);
    if (!byCommand.has(key)) byCommand.set(key, []);
    byCommand.get(key).push(harness);
  }

  return harnesses.map((harness) => {
    const duplicateGroup = byCommand.get(harnessCommandKey(harness)) || [];
    const betterDuplicate = preferredHarness(duplicateGroup);
    const reasons = [];
    let category = KEEP;

    if (harness.status === 'ARCHIVED') {
      category = CLEANUP;
      reasons.push('Archived; kept for history and removed from the daily working set.');
    }
    if (harness.status === 'DISABLED') {
      category = CLEANUP;
      reasons.push('Disabled cleanup candidate; move it to the archive instead of leaving it as an ambiguous off state.');
    }
    if (harness.status === 'DRAFT') {
      category = CONDITIONAL;
      reasons.push('Draft harnesses are useful only while being tested or promoted.');
    }
    if (isJudgingArtifact(harness)) {
      category = category === CLEANUP ? CLEANUP : CONDITIONAL;
      reasons.push('Judging artifact; show mainly during submission or review preparation.');
    }
    if (harness.lastTest && !harness.lastTest.passed) {
      category = CLEANUP;
      reasons.push('Latest harness test failed, so it should not stay in the active/default path.');
    }
    if (betterDuplicate && betterDuplicate.id !== harness.id) {
      category = CLEANUP;
      reasons.push(`Duplicates ${betterDuplicate.id} with the same command shape.`);
    }
    if (harness.status === 'ACTIVE' && harness.source === 'BUILTIN' && category !== CLEANUP && !isJudgingArtifact(harness)) {
      category = KEEP;
      reasons.unshift('Built-in active baseline used by the normal work loop.');
    }

    return finding('HARNESS', harness, category, reasons, betterDuplicate);
  });
}

function auditSkills(skills) {
  const groups = groupSimilarSkills(skills);
  return skills.map((skill) => {
    const group = groups.find((items) => items.some((item) => item.id === skill.id)) || [skill];
    const betterDuplicate = preferredSkill(group);
    const reasons = [];
    let category = KEEP;

    if (skill.status === 'ARCHIVED') {
      category = CLEANUP;
      reasons.push('Archived; kept for history and hidden from normal task guidance.');
    }
    if (skill.status === 'DISABLED') {
      category = CLEANUP;
      reasons.push('Disabled cleanup candidate; move it to the archive instead of leaving it as an ambiguous off state.');
    }
    if (skill.status === 'DRAFT') {
      category = CLEANUP;
      reasons.push('Draft skill is not part of the active work loop.');
    }
    if (isScopeArtifact(skill) && group.length > 1 && betterDuplicate.id !== skill.id) {
      category = CLEANUP;
      reasons.push(`Overlaps with ${betterDuplicate.id}; keep the more general scope rule.`);
    }
    if (!isScopeArtifact(skill) && isJudgingArtifact(skill)) {
      category = category === CLEANUP ? CLEANUP : CONDITIONAL;
      reasons.push('Judging guidance; useful for submission review, not every implementation task.');
    }
    if (isSituationalSkill(skill) && category !== CLEANUP) {
      category = CONDITIONAL;
      reasons.push('Situational skill; keep available, but do not show as default guidance for every task.');
    }
    if (hasTooManySpecificPathRules(skill)) {
      category = category === KEEP ? CONDITIONAL : category;
      reasons.push('Contains many file-specific scope rules; archive the concrete cases and keep only the general lesson.');
    }
    if (skill.status === 'ACTIVE' && isCoreSkill(skill) && category !== CLEANUP) {
      category = KEEP;
      reasons.unshift('Core work-loop rule that applies broadly.');
    }

    return finding('SKILL', skill, category, reasons, betterDuplicate);
  });
}

function finding(type, artifact, category, reasons, duplicateOf = null) {
  const action = recommendedAction(artifact, category, duplicateOf);
  return {
    type,
    id: artifact.id,
    label: artifact.label || artifact.id,
    status: artifact.status,
    source: artifact.source,
    category,
    action,
    duplicateOf: duplicateOf?.id || null,
    reasons: reasons.length ? reasons : ['No cleanup signal detected.'],
  };
}

function recommendedAction(artifact, category, duplicateOf) {
  if (category === KEEP) return 'KEEP';
  if (category === CONDITIONAL) return 'HIDE_BY_DEFAULT';
  if (artifact.status === 'ARCHIVED') return 'HIDE_BY_DEFAULT';
  if (artifact.status === 'DISABLED') return 'ARCHIVE';
  if (duplicateOf || artifact.status === 'DRAFT' || artifact.source === 'FAILURE_DERIVED' || artifact.lastTest?.passed === false) return 'ARCHIVE';
  return 'REVIEW';
}

function cleanupActions(harnessFindings, skillFindings) {
  return [...harnessFindings, ...skillFindings]
    .filter((item) => item.action === 'ARCHIVE')
    .map((item) => ({ type: item.type, id: item.id, reason: item.reasons[0] || 'Cleanup recommended.' }));
}

function summarize(findings) {
  const counts = { keep: 0, conditional: 0, cleanup: 0, reviewOnly: 0, archiveActions: 0, disableActions: 0 };
  for (const finding of findings) {
    if (finding.category === KEEP) counts.keep += 1;
    if (finding.category === CONDITIONAL) counts.conditional += 1;
    if (finding.category === CLEANUP) counts.cleanup += 1;
    if (finding.category === REVIEW_ONLY) counts.reviewOnly += 1;
    if (finding.action === 'ARCHIVE') counts.archiveActions += 1;
    if (finding.action === 'DISABLE') counts.disableActions += 1;
  }
  return counts;
}

function harnessCommandKey(harness) {
  return JSON.stringify((harness.commands || []).map((command) => ({
    file: String(command.file || ''),
    args: (command.args || []).map(String),
    cwd: String(command.cwd || '.'),
    expectedExit: Number.isInteger(command.expectedExit) ? command.expectedExit : 0,
  })));
}

function preferredHarness(items) {
  return [...items].sort((a, b) => artifactRank(a) - artifactRank(b)
    || sourceRank(a) - sourceRank(b)
    || String(a.id).localeCompare(String(b.id)))[0] || null;
}

function preferredSkill(items) {
  return [...items].sort((a, b) => artifactRank(a) - artifactRank(b)
    || sourceRank(a) - sourceRank(b)
    || scopeSkillRank(a) - scopeSkillRank(b)
    || String(a.id).localeCompare(String(b.id)))[0] || null;
}

function artifactRank(item) {
  const status = { ACTIVE: 0, DRAFT: 1, DISABLED: 2, ARCHIVED: 3 };
  return status[item.status] ?? 9;
}

function sourceRank(item) {
  const source = { BUILTIN: 0, IMPORTED_LOCAL_SKILL: 1, FAILURE_DERIVED: 2, USER: 3 };
  return source[item.source] ?? 9;
}

function scopeSkillRank(skill) {
  if (skill.id === 'scope-guard') return 0;
  return hasTooManySpecificPathRules(skill) ? 2 : 1;
}

function groupSimilarSkills(skills) {
  const groups = [];
  const used = new Set();
  for (const skill of skills) {
    if (used.has(skill.id)) continue;
    const group = skills.filter((candidate) => candidate.id === skill.id || skillSimilarityKey(candidate) === skillSimilarityKey(skill));
    for (const item of group) used.add(item.id);
    groups.push(group);
  }
  return groups;
}

function skillSimilarityKey(skill) {
  if (isScopeArtifact(skill)) return 'scope-violation';
  if (isJudgingArtifact(skill)) return `judging:${String(skill.id).replace(/-[a-f0-9]{8,}$/i, '')}`;
  return `skill:${skill.id}`;
}

function isCoreSkill(skill) {
  return ['execution-verification', 'failure-corpus-discipline', 'root-cause-diagnosis'].includes(skill.id);
}

function isSituationalSkill(skill) {
  return ['path-escape-qa', 'powershell-encoding'].includes(skill.id);
}

function isScopeArtifact(skill) {
  return String(skill.id).includes('scope-violation')
    || skill.id === 'scope-guard';
}

function isJudgingArtifact(artifact) {
  return String(artifact.id || '').startsWith('judging-') || /judging|submission|nhn|video clarity|technical documentation/i.test(artifactText(artifact));
}

function hasTooManySpecificPathRules(skill) {
  const rules = skill.rules || [];
  return rules.filter((rule) => /`[^`]+\.(js|mjs|css|html|md|json)`/.test(String(rule))).length >= 3;
}

function artifactText(artifact) {
  return [
    artifact.id,
    artifact.label,
    artifact.description,
    ...(artifact.rules || []),
  ].filter(Boolean).join('\n');
}
