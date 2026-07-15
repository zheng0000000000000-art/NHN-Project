import { HttpError } from './utils.js';

export class FailureLearningService {
  constructor({ failureCases, harnessRegistry, skillRegistry }) {
    this.failureCases = failureCases;
    this.harnessRegistry = harnessRegistry;
    this.skillRegistry = skillRegistry;
  }

  async craft(actor, input) {
    const type = String(input.type ?? '').toUpperCase();
    if (!['HARNESS', 'SKILL'].includes(type)) throw new HttpError(400, 'Learning artifact type must be HARNESS or SKILL.');
    const failureCaseIds = [...new Set((Array.isArray(input.failureCaseIds) ? input.failureCaseIds : [])
      .map((item) => String(item).trim()).filter(Boolean))];
    if (failureCaseIds.length === 0 || failureCaseIds.length > 50) throw new HttpError(400, 'Select 1-50 failure cases.');

    const cases = [];
    for (const id of failureCaseIds) {
      const item = await this.failureCases.get(id);
      if (!item) throw new HttpError(404, `Failure case not found: ${id}`);
      cases.push(item);
    }

    if (type === 'HARNESS') {
      const harness = await this.harnessRegistry.createFromFailures(actor, input, cases);
      const fixtureCandidates = [];
      for (const failure of cases) {
        const candidate = await this.harnessRegistry.addFixtureCandidate(harness.id, failure, actor.id);
        fixtureCandidates.push(candidate);
        await this.failureCases.linkFixtureCandidate(failure.id, actor.id, candidate.id);
      }
      const finalHarness = await this.harnessRegistry.get(harness.id);
      for (const failure of cases) {
        await this.failureCases.linkLearningArtifact(failure.id, actor.id, { type: 'HARNESS', id: finalHarness.id, version: finalHarness.version });
      }
      return { type, harness: finalHarness, fixtureCandidates, sourceFailureCases: cases };
    }

    const skill = await this.skillRegistry.createFromFailures(actor, input, cases);
    for (const failure of cases) {
      await this.failureCases.linkLearningArtifact(failure.id, actor.id, { type: 'SKILL', id: skill.id, version: skill.version });
    }
    return { type, skill, sourceFailureCases: cases };
  }

  async applyToTask({ actor, store, taskId, expectedVersion, harnessId, skillIds }) {
    const current = await store.getTask(taskId);
    if (!current) throw new HttpError(404, 'Task not found.');
    if (current.status === 'DONE') throw new HttpError(409, 'Learning artifacts cannot be applied to a DONE task.');
    if (current.status === 'REVIEW') throw new HttpError(409, 'Move the task out of REVIEW before changing its harness or skills.');

    let harness = null;
    if (harnessId) harness = await this.harnessRegistry.resolveActive(String(harnessId));
    const skills = await this.skillRegistry.resolveActiveMany(skillIds ?? []);
    if (!harness && skills.length === 0) throw new HttpError(400, 'Provide an active harness or at least one active skill.');

    const task = await store.mutateTask(taskId, actor, expectedVersion, 'LEARNING_APPLIED', async (next) => {
      if (harness) next.verificationProfile = harness.id;
      const existingSkillIds = Array.isArray(next.skillIds) ? next.skillIds : [];
      next.skillIds = [...new Set([...existingSkillIds, ...skills.map((item) => item.id)])].sort();
      next.learning = next.learning ?? { applications: [] };
      next.learning.applications = Array.isArray(next.learning.applications) ? next.learning.applications : [];
      next.learning.applications.push({
        at: new Date().toISOString(),
        appliedByUserId: actor.id,
        harnessId: harness?.id ?? null,
        harnessVersion: harness?.version ?? null,
        skillIds: skills.map((item) => item.id),
        skillVersions: Object.fromEntries(skills.map((item) => [item.id, item.version])),
        sourceFailureCaseIds: [...new Set([
          ...(harness?.sourceFailureCaseIds ?? []),
          ...skills.flatMap((item) => item.sourceFailureCaseIds ?? []),
        ])].sort(),
      });
      next.verification = null;
      next.review = null;
    });

    return { task, harness, skills };
  }
}
