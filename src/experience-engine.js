import { selectLearningForTask } from './learning-selector.js';
import { inferSkillManifest, normalizeContextPackContract, normalizeHarnessContract } from './contracts.js';

export class ExperienceEngine {
  constructor({ projectContext, contextIndex, wiki, failureCases, harnessRegistry, skillRegistry }) {
    this.projectContext = projectContext;
    this.contextIndex = contextIndex;
    this.wiki = wiki;
    this.failureCases = failureCases;
    this.harnessRegistry = harnessRegistry;
    this.skillRegistry = skillRegistry;
  }

  async prepare(input = {}) {
    const descriptor = normalizeDescriptor(input);
    const query = descriptorQuery(descriptor);
    const [project, wikiEntries, harnesses, skills, failures] = await Promise.all([
      this.projectContext.get(),
      this.wiki.search(query, { limit: input.maxWikiEntries || 8 }),
      this.harnessRegistry.list({ includeDisabled: false }),
      this.skillRegistry.list({ includeDisabled: false }),
      this.failureCases.list({ limit: 200 }),
    ]);
    const selection = selectLearningForTask(descriptor, {
      activeHarnesses: harnesses,
      activeSkills: skills,
      defaultProfile: input.defaultHarnessId || 'repository-basic',
    });
    const relevantFailures = selectFailures(query, failures, 8);
    const sources = this.contextIndex.search(query, {
      maxChunks: clamp(input.maxSourceChunks, 1, 12, 6),
      maxCharacters: clamp(input.maxSourceCharacters, 1000, 24000, 9000),
    });
    const sourceFiles = [...new Map(sources.sources.map((source) => [source.path, source])).values()];
    const requiredInputs = sourceFiles
      .filter((source) => source.fileSha256 && !pathInScope(source.path, descriptor.allowedPaths))
      .map((source) => ({ path: source.path, sha256: source.fileSha256 }));
    const contract = normalizeContextPackContract({
      packId: input.packId || `experience-${stablePackId(descriptor.title)}`,
      requiredInputs,
      readOrder: sourceFiles.map((item) => item.path),
      writeScope: descriptor.allowedPaths,
      forbiddenActions: input.forbiddenActions || ['approve', 'reject', 'promote-knowledge-without-review'],
    });
    const selectedHarness = harnesses.find((item) => item.id === selection.verificationProfile);
    const selectedSkills = skills.filter((item) => selection.skillIds.includes(item.id));

    return {
      schemaVersion: 1,
      kind: 'team-loop-experience-pack',
      contract,
      preparedAt: new Date().toISOString(),
      goal: descriptor.title,
      projectContext: project.content ? project : null,
      wiki: wikiEntries,
      sources,
      learning: {
        selectedHarnessId: selection.verificationProfile,
        selectedSkillIds: selection.skillIds,
        harnessContract: selectedHarness?.commands?.length ? normalizeHarnessContract(selectedHarness) : null,
        skillManifests: selectedSkills.map((skill) => ({ id: skill.id, manifest: inferSkillManifest(skill) })),
        rationale: selection.rationale,
        relevantFailures,
      },
      instructions: [
        'Use the selected context as evidence, not as unquestioned truth.',
        'Run the selected harness before reporting success.',
        'After work, call experience_reflect with discoveries, failures, and the artifacts actually used.',
      ],
    };
  }

  reflectionCandidates(reflection) {
    const wikiCandidates = reflection.discoveries.map((content, index) => ({
      title: candidateTitle(content, index),
      content,
      tags: ['experience', reflection.verdict.toLowerCase()],
      evidence: reflection.taskId ? [`task:${reflection.taskId}`] : [],
    }));
    return {
      wikiCandidates,
      learningCandidate: reflection.failureCaseIds.length ? {
        failureCaseIds: reflection.failureCaseIds,
        recommendation: reflection.failureCaseIds.length > 1 ? 'Consider a reusable skill or regression harness.' : 'Review the failure for a reusable skill or harness.',
      } : null,
    };
  }
}

function normalizeDescriptor(input) {
  return {
    title: String(input.goal || input.title || '').trim().slice(0, 2000),
    description: String(input.description || '').trim().slice(0, 4000),
    allowedPaths: list(input.allowedPaths, 100),
    acceptanceCriteria: list(input.acceptanceCriteria, 30),
  };
}

function descriptorQuery(descriptor) {
  return [descriptor.title, descriptor.description, ...descriptor.allowedPaths, ...descriptor.acceptanceCriteria].filter(Boolean).join('\n');
}

function selectFailures(query, failures, limit) {
  const tokens = tokenize(query);
  return failures
    .filter((failure) => ['OPEN', 'FIXTURE_CANDIDATE', 'RESOLVED'].includes(failure.status))
    .map((failure) => ({ failure, score: overlap(tokens, tokenize([
      failure.title, failure.kind, failure.harnessId, ...(failure.taskIds || []),
    ].join(' '))) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.failure.lastSeenAt.localeCompare(a.failure.lastSeenAt))
    .slice(0, limit)
    .map(({ failure, score }) => ({
      id: failure.id,
      title: failure.title,
      kind: failure.kind,
      status: failure.status,
      occurrences: failure.occurrences,
      harnessId: failure.harnessId,
      relevance: score,
    }));
}

function tokenize(value) {
  return new Set(String(value || '').toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((item) => item.length >= 2));
}

function overlap(left, right) {
  let score = 0;
  for (const token of left) if (right.has(token)) score += 1;
  return score;
}

function list(value, max) {
  return (Array.isArray(value) ? value : []).map(String).map((item) => item.trim()).filter(Boolean).slice(0, max);
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function candidateTitle(content, index) {
  const compact = String(content).replace(/\s+/g, ' ').trim();
  return compact.slice(0, 100) || `Experience discovery ${index + 1}`;
}

function stablePackId(value) {
  return String(value || 'work').toLowerCase().replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'work';
}

function pathInScope(target, scopes) {
  return scopes.some((scope) => {
    const normalized = String(scope).replaceAll('\\', '/');
    const prefix = normalized.replace(/\*.*$/, '').replace(/\/+$/, '');
    return normalized === '**' || target === normalized || (prefix && (target === prefix || target.startsWith(`${prefix}/`)));
  });
}
