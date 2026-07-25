import path from 'node:path';
import { atomicWriteJson, HttpError, nowIso, randomId, readJson } from './utils.js';
import { evidenceBasis, isRerunnableFailure } from './failure-evidence.js';

const EMPTY_LEDGER = { schemaVersion: 1, receipts: [] };

export class PromotionEngine {
  constructor({ dataDirectory, policyPath, failureCases, harnessRegistry, skillRegistry, resolveIndependentReview = null }) {
    this.path = path.join(dataDirectory, 'promotion-receipts.json');
    this.policyPath = policyPath;
    this.failureCases = failureCases;
    this.harnessRegistry = harnessRegistry;
    this.skillRegistry = skillRegistry;
    // ADR-002 독립 관찰자 원칙: 만든 주체가 자기 산출물을 켜지 못하게 한다.
    this.resolveIndependentReview = resolveIndependentReview;
    this.policy = null;
    this.lock = Promise.resolve();
  }

  async initialize() {
    this.policy = normalizePolicy(await readJson(this.policyPath, {}));
    await this.#withLock(async () => {
      const db = await readJson(this.path, EMPTY_LEDGER);
      if (!Array.isArray(db.receipts)) throw new Error('Invalid promotion receipt ledger.');
      await atomicWriteJson(this.path, db);
    });
  }

  status() {
    return structuredClone(this.policy);
  }

  async candidates(actorUserId) {
    const [cases, harnesses, skills, receipts] = await Promise.all([
      this.failureCases.list({ limit: 1000 }),
      this.harnessRegistry.list(),
      this.skillRegistry.list(),
      this.list(actorUserId, { limit: 200 }),
    ]);
    const covered = new Set([
      ...harnesses.flatMap((item) => (item.sourceFailureCaseIds || []).map((id) => id)),
      ...skills.flatMap((item) => (item.sourceFailureCaseIds || []).map((id) => id)),
      ...receipts.flatMap((item) => item.sourceFailureCaseIds || []),
    ]);
    return cases
      .filter((item) => [item.firstSeenByUserId, item.lastSeenByUserId].includes(actorUserId))
      .filter((item) => item.occurrences >= this.policy.minimumOccurrences && !covered.has(item.id) && item.status !== 'IGNORED')
      .map((item) => scoreCandidate([item]))
      .sort((a, b) => b.score.total - a.score.total || b.occurrences - a.occurrences);
  }

  async list(actorUserId, { limit = 50 } = {}) {
    const db = await readJson(this.path, EMPTY_LEDGER);
    return db.receipts.filter((item) => item.actorUserId === actorUserId)
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))
      .map((item) => structuredClone(item));
  }

  async activate(actor, result, plan) {
    const artifact = result.skill || result.harness;
    const type = result.skill ? 'SKILL' : 'HARNESS';
    const assessment = scoreCandidate(result.sourceFailureCases);
    const snapshot = structuredClone(artifact);
    let blockedReason = approvalReason(type, artifact);
    // 자기가 등록한 실패에서 자기가 만든 아티팩트를 자기가 켜는 경로를 막는다.
    const review = await this.#independentReview(actor, type, artifact);
    if (!blockedReason && !review.independent) blockedReason = review.reason || 'NO_INDEPENDENT_REVIEW';
    let status = 'CANDIDATE';
    let activated = artifact;
    let test = null;
    if (blockedReason) {
      status = 'AWAITING_APPROVAL';
    } else if (type === 'SKILL') {
      activated = await this.skillRegistry.setStatus(artifact.id, actor.id, artifact.version, 'ACTIVE');
      status = 'PROBATION';
    } else {
      test = await this.harnessRegistry.test(artifact.id, actor.id);
      activated = test.harness;
      if (test.test.passed) {
        activated = await this.harnessRegistry.setStatus(activated.id, actor.id, activated.version, 'ACTIVE');
        status = 'PROBATION';
      } else {
        status = 'QUARANTINED';
      }
    }
    const receipt = {
      schemaVersion: 1,
      kind: 'team-loop-promotion-receipt',
      id: randomId('promo_'),
      actorUserId: actor.id,
      mode: this.policy.mode,
      type,
      artifactId: artifact.id,
      artifactVersion: activated.version,
      status,
      sourceFailureCaseIds: result.sourceFailureCases.map((item) => item.id),
      baselineOccurrences: Object.fromEntries(result.sourceFailureCases.map((item) => [item.id, item.occurrences])),
      score: assessment.score,
      rationale: plan.rationale,
      planner: plan.planner,
      snapshot,
      test: test?.test || null,
      review,
      blockedReason,
      cleanAudits: 0,
      createdAt: nowIso(),
      activatedAt: status === 'PROBATION' ? nowIso() : null,
      stabilizedAt: null,
      rolledBackAt: null,
      rollbackReason: null,
    };
    await this.#withLock(async () => {
      const db = await readJson(this.path, EMPTY_LEDGER);
      db.receipts.unshift(receipt);
      db.receipts = db.receipts.slice(0, 500);
      await atomicWriteJson(this.path, db);
    });
    return { ...result, [type === 'SKILL' ? 'skill' : 'harness']: activated, promotion: structuredClone(receipt) };
  }

  async audit(actor) {
    return this.#withLock(async () => {
      const db = await readJson(this.path, EMPTY_LEDGER);
      const changes = [];
      for (const receipt of db.receipts.filter((item) => item.actorUserId === actor.id && item.status === 'PROBATION')) {
        const regression = await this.#regression(receipt);
        if (regression) {
          const artifact = receipt.type === 'SKILL'
            ? await this.skillRegistry.get(receipt.artifactId)
            : await this.harnessRegistry.get(receipt.artifactId);
          if (artifact?.status === 'ACTIVE') {
            if (receipt.type === 'SKILL') await this.skillRegistry.setStatus(artifact.id, actor.id, artifact.version, 'DISABLED');
            else await this.harnessRegistry.setStatus(artifact.id, actor.id, artifact.version, 'DISABLED');
          }
          receipt.status = 'ROLLED_BACK';
          receipt.rolledBackAt = nowIso();
          receipt.rollbackReason = regression;
          changes.push({ id: receipt.id, artifactId: receipt.artifactId, status: receipt.status, reason: regression });
          continue;
        }
        receipt.cleanAudits += 1;
        if (receipt.cleanAudits >= this.policy.stableAfterCleanAudits) {
          receipt.status = 'STABLE';
          receipt.stabilizedAt = nowIso();
          changes.push({ id: receipt.id, artifactId: receipt.artifactId, status: receipt.status });
        }
      }
      if (changes.length || db.receipts.some((item) => item.status === 'PROBATION')) await atomicWriteJson(this.path, db);
      return changes;
    });
  }

  async #regression(receipt) {
    for (const id of receipt.sourceFailureCaseIds) {
      const failure = await this.failureCases.get(id);
      if (!failure) continue;
      if (Number(failure.occurrences) > Number(receipt.baselineOccurrences[id] || 0)) {
        return `Failure ${id} recurred after optimistic activation (${receipt.baselineOccurrences[id]} → ${failure.occurrences}).`;
      }
    }
    return null;
  }

  #withLock(work) {
    const result = this.lock.then(work, work);
    this.lock = result.catch(() => {});
    return result;
  }

  // 독립 검증자를 조회한다. 주입이 없거나 검증자가 제작 주체와 같으면 독립이 아니다.
  async #independentReview(actor, type, artifact) {
    if (typeof this.resolveIndependentReview !== 'function') {
      return { independent: false, reason: 'NO_INDEPENDENT_REVIEW', reviewerProfileId: null };
    }
    try {
      const resolved = await this.resolveIndependentReview({ actor, type, artifact });
      return {
        independent: resolved?.independent === true,
        reason: resolved?.independent === true ? null : (resolved?.reason || 'NO_INDEPENDENT_REVIEW'),
        reviewerProfileId: resolved?.reviewerProfileId ?? null,
      };
    } catch {
      return { independent: false, reason: 'INDEPENDENT_REVIEW_UNAVAILABLE', reviewerProfileId: null };
    }
  }
}

function scoreCandidate(cases) {
  const occurrences = cases.reduce((sum, item) => sum + Number(item.occurrences || 0), 0);
  // 파일명이 비어있지 않다는 사실은 근거가 아니다. delivery gate가 남긴 라벨도 그 조건을 통과한다.
  // 다시 실행 가능한 명령 근거가 있을 때만 하네스로 점수화한다.
  const executable = cases.some((item) => isRerunnableFailure(item));
  const readOnly = cases.every((item) => !item.lastEvidence?.changedPaths?.length);
  const observable = cases.some((item) => item.lastEvidence?.actualExit != null || item.lastEvidence?.error || item.lastEvidence?.paths?.length);
  const dimensions = {
    repeatability: occurrences >= 3 ? 2 : occurrences >= 2 ? 1 : 0,
    decidability: executable ? 2 : 1,
    failureInjection: executable ? 2 : 1,
    isolation: readOnly ? 2 : 1,
    observability: observable ? 2 : 1,
    maintenanceValue: occurrences >= 2 ? 2 : 1,
  };
  const total = Object.values(dimensions).reduce((sum, value) => sum + value, 0);
  return {
    failureCaseIds: cases.map((item) => item.id),
    title: cases.map((item) => item.title).join(' · '),
    occurrences,
    suggestedType: executable ? 'HARNESS' : 'SKILL',
    evidenceBasis: evidenceBasis(cases),
    score: { total, dimensions, verdict: total >= 11 ? 'CREATE_NOW' : total >= 8 ? 'OPTIMISTIC_TRIAL' : total >= 5 ? 'HOLD' : 'NOTE' },
  };
}

function approvalReason(type, artifact) {
  if (type === 'HARNESS' && (artifact.commands || []).some((item) => item.mutatesState)) return 'IRREVERSIBLE_CHANGE';
  if (type === 'SKILL' && (artifact.manifest?.sideEffectScope || []).some((item) => /external|shared|remote|billing/i.test(item))) return 'EXTERNAL_SIDE_EFFECT';
  return null;
}

function normalizePolicy(input) {
  return {
    schemaVersion: 1,
    mode: String(input.mode || 'OPTIMISTIC').toUpperCase(),
    minimumOccurrences: Math.max(1, Number(input.minimumOccurrences) || 1),
    stableAfterCleanAudits: Math.max(1, Number(input.stableAfterCleanAudits) || 3),
    snapshotRequired: input.snapshotRequired !== false,
    autoRollback: input.autoRollback !== false,
    approvalRequiredFor: Array.isArray(input.approvalRequiredFor) ? input.approvalRequiredFor.map(String) : [],
  };
}
