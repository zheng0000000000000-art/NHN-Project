import path from 'node:path';
import { atomicWriteJson, HttpError, nowIso, randomId, readJson } from './utils.js';
import { evidenceBasis, injectionReadiness } from './failure-evidence.js';

const EMPTY_LEDGER = { schemaVersion: 1, receipts: [] };

export class PromotionEngine {
  constructor({ dataDirectory, policyPath, failureCases, harnessRegistry, skillRegistry, wikiStore = null, resolveIndependentReview = null }) {
    this.path = path.join(dataDirectory, 'promotion-receipts.json');
    this.policyPath = policyPath;
    this.failureCases = failureCases;
    this.harnessRegistry = harnessRegistry;
    this.skillRegistry = skillRegistry;
    // 기계가 판정할 수 없는 것은 규칙으로 굳히지 않고 지식으로 남긴다.
    this.wikiStore = wikiStore;
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

  // 판정 불가로 분류된 후보를 위키 후보로 올린다. 규칙이 아니라 관측 기록이므로
  // CANDIDATE 상태로만 들어가고, 채택은 사람 몫이다. 영수증을 남겨 같은 것이 다시 올라오지 않게 한다.
  async fileAsKnowledge(actor, candidate, cases) {
    if (!this.wikiStore) throw new HttpError(409, 'No wiki store is configured for undecidable candidates.');
    if (candidate?.suggestedType !== 'WIKI') throw new HttpError(400, 'Only undecidable candidates are filed as knowledge.');
    const proposal = await this.wikiStore.propose(actor, {
      title: `관측: ${String(candidate.title).slice(0, 160)}`,
      content: knowledgeContent(candidate, cases),
      tags: ['promotion', 'undecidable', ...new Set(cases.map((item) => String(item.kind || '').toLowerCase()).filter(Boolean))],
      evidence: candidate.failureCaseIds,
    });
    const receipt = {
      schemaVersion: 1,
      kind: 'team-loop-promotion-receipt',
      id: randomId('promo_'),
      actorUserId: actor.id,
      mode: this.policy.mode,
      type: 'WIKI',
      artifactId: proposal.entry.id,
      artifactVersion: 1,
      status: proposal.duplicate ? 'ALREADY_FILED' : 'FILED',
      sourceFailureCaseIds: candidate.failureCaseIds,
      baselineOccurrences: Object.fromEntries(cases.map((item) => [item.id, item.occurrences])),
      score: candidate.score,
      rationale: 'A machine cannot decide this from the recorded evidence, so it is filed as knowledge rather than enforced as a rule.',
      planner: 'decidability-routing',
      snapshot: structuredClone(proposal.entry),
      test: null,
      review: null,
      blockedReason: null,
      cleanAudits: 0,
      createdAt: nowIso(),
      activatedAt: null,
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
    return { entry: proposal.entry, duplicate: proposal.duplicate, promotion: structuredClone(receipt) };
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

// 결정가능성: 기계가 PASS/FAIL로 가를 수 있는가. 0은 "사람 해석이 필요하다"는 뜻이고,
// 그 값이 표현되지 않으면 무엇을 프로그램에 맡길지 정할 근거 자체가 사라진다.
// 0 = 보고된 결과뿐 · 1 = 관측된 상태는 있으나 재실행 불가 · 2 = 다시 실행해 exit code로 가른다.
export const DECIDABILITY_BY_BASIS = { REPLAYABLE_COMMAND: 2, OBSERVED_STATE: 1, REPORTED_OUTCOME: 0 };

// Y/N으로 답할 수 있으면 프로그램이, 절차면 스킬이, 나머지는 위키가 맡는다.
export const ARTIFACT_BY_DECIDABILITY = { 2: 'HARNESS', 1: 'SKILL', 0: 'WIKI' };

function scoreCandidate(cases) {
  const occurrences = cases.reduce((sum, item) => sum + Number(item.occurrences || 0), 0);
  // 파일명이 비어있지 않다는 사실은 근거가 아니다. delivery gate가 남긴 라벨도 그 조건을 통과한다.
  const basis = evidenceBasis(cases);
  const decidability = DECIDABILITY_BY_BASIS[basis] ?? 0;
  const readOnly = cases.every((item) => !item.lastEvidence?.changedPaths?.length);
  const observable = cases.some((item) => item.lastEvidence?.actualExit != null || item.lastEvidence?.error || item.lastEvidence?.paths?.length);
  const dimensions = {
    repeatability: occurrences >= 3 ? 2 : occurrences >= 2 ? 1 : 0,
    decidability,
    // 이전에는 decidability를 그대로 복사했다. 12점 중 4점이 한 번의 측정에서 나왔다는 뜻이고,
    // 판정자에게 같은 증거를 두 번 세어 주는 것이었다. 실측: 코퍼스 52건 중 7건이 갈린다 —
    // 다시 돌릴 명령은 있는데 망가뜨릴 대상이 없어 주입 명세를 쓸 수 없는 케이스들이다.
    failureInjection: injectionReadiness(cases),
    isolation: readOnly ? 2 : 1,
    observability: observable ? 2 : 1,
    maintenanceValue: occurrences >= 2 ? 2 : 1,
  };
  const total = Object.values(dimensions).reduce((sum, value) => sum + value, 0);
  return {
    failureCaseIds: cases.map((item) => item.id),
    title: cases.map((item) => item.title).join(' · '),
    occurrences,
    suggestedType: ARTIFACT_BY_DECIDABILITY[decidability],
    evidenceBasis: basis,
    score: { total, dimensions, verdict: total >= 11 ? 'CREATE_NOW' : total >= 8 ? 'OPTIMISTIC_TRIAL' : total >= 5 ? 'HOLD' : 'NOTE' },
  };
}

// 위키 본문. 무엇이 관측됐고 왜 규칙으로 굳히지 않았는지를 적는다. 규칙처럼 읽히면 안 된다.
function knowledgeContent(candidate, cases) {
  const lines = [
    `관측 ${candidate.occurrences}회. 근거 성격: ${candidate.evidenceBasis}.`,
    '',
    '기계가 PASS/FAIL로 가를 수 있는 근거가 없어 하네스로도 스킬로도 굳히지 않았다.',
    '재실행 가능한 명령이나 검사 가능한 상태가 확보되면 그때 승격 후보로 다시 올라온다.',
    '',
    '관측된 실패:',
    ...cases.map((item) => `- ${item.kind}: ${String(item.title || '').slice(0, 200)} (${item.occurrences}회, ${item.id})`),
    '',
    `점수 ${candidate.score.total}/12 · 판정 ${candidate.score.verdict} · 결정가능성 ${candidate.score.dimensions.decidability}`,
  ];
  return lines.join('\n');
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
