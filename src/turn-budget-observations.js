// 턴 예산이 실제로 충분했는지를 실행마다 관측해 append-only로 쌓는다.
//
// 지금 maxTurns는 고정값이고, 그 값이 맞는지 아무도 재지 않는다. 값을 또 지어내는 대신
// 실행마다 "어떤 모양의 일에 몇 턴을 줬고, 무엇이 나왔는가"를 남긴다. 티어별 하한은
// 데이터가 쌓인 뒤 사람이 정한다 — 이 파일은 판정하지 않고 관측만 한다.
import path from 'node:path';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { nowIso } from './utils.js';
import { classifyWorkKind } from './work-kind.js';
import { unverifiedClaims } from './unverified-claims.js';

const TERMINAL_MAX_TURNS = 'max_turns';

// 실행자 결과 문자열에서 턴 수와 종료 사유를 꺼낸다. 없으면 null이지 0이 아니다.
export function executorTelemetry(verification) {
  const checks = Array.isArray(verification?.checks) ? verification.checks : [];
  const failure = [...checks].reverse().find((check) => check?.executorFailure)?.executorFailure;
  const excerpt = String(failure?.outputExcerpt ?? '').trim();
  let parsed = null;
  try { parsed = excerpt ? JSON.parse(excerpt) : null; } catch { parsed = null; }
  return {
    numTurns: Number.isFinite(Number(parsed?.num_turns)) ? Number(parsed.num_turns) : null,
    terminalReason: parsed?.terminal_reason ? String(parsed.terminal_reason).slice(0, 60) : null,
    permissionDenials: Array.isArray(parsed?.permission_denials) ? parsed.permission_denials.length : null,
    subtype: failure?.subtype ?? null,
  };
}

// 실행 하나를 관측 한 줄로 바꾼다. 티어는 여기서 정하지 않는다 —
// allowedPaths와 verificationProfile을 그대로 남겨 분석 시점에 파생한다.
export function observationFromTask(task) {
  const verification = task?.verification ?? null;
  const preflight = task?.agentActivity?.preflight ?? null;
  const telemetry = executorTelemetry(verification);
  const changedPaths = Array.isArray(verification?.changedPaths) ? verification.changedPaths : [];
  const delivered = changedPaths.length > 0;
  return {
    schemaVersion: 1,
    at: nowIso(),
    taskId: task?.id ?? null,
    // 일의 모양 (분석 시점에 티어를 파생할 수 있는 원재료)
    verificationProfile: task?.verificationProfile ?? null,
    allowedPaths: Array.isArray(task?.allowedPaths) ? task.allowedPaths : [],
    criteriaCount: Array.isArray(task?.acceptanceCriteria) ? task.acceptanceCriteria.length : 0,
    delegationDepth: Number(task?.delegation?.depth) || 0,
    // 종류 판정과 그 근거를 함께 남긴다. 판정이 틀린 것으로 드러나면 근거를 보고 고칠 수 있다.
    workKind: classifyWorkKind(task).kind,
    readOnlyReferenceCount: classifyWorkKind(task).evidence.readOnlyReferenceCount,
    // 실행자가 Y/N을 주장했는데 프로그램 판정이 뒷받침하지 않으면 하네스가 빠진 자리다.
    claimAudit: (() => {
      const audited = unverifiedClaims({
        report: executorReport(verification),
        verification,
        source: task?.executor?.tool ?? null,
      });
      return { claims: audited.claims.map((item) => item.id), missingHarness: audited.missingHarness, contradicted: audited.contradicted };
    })(),
    // 준 예산
    maxTurns: Number.isFinite(Number(preflight?.maxTurns)) ? Number(preflight.maxTurns) : null,
    contextEstimatedTokens: Number.isFinite(Number(preflight?.selectedContext?.estimatedTokens))
      ? Number(preflight.selectedContext.estimatedTokens) : null,
    contextSourceCount: Number.isFinite(Number(preflight?.selectedContext?.sourceCount))
      ? Number(preflight.selectedContext.sourceCount) : null,
    // 실제로 쓴 것과 나온 것
    numTurns: telemetry.numTurns,
    terminalReason: telemetry.terminalReason,
    permissionDenials: telemetry.permissionDenials,
    changedPathCount: changedPaths.length,
    delivered,
    outcome: outcomeOf({ delivered, telemetry, verification }),
    cumulativeTokens: Number(task?.automationGuard?.cumulativeTokens) || 0,
    cumulativeCostUsd: Number(task?.automationGuard?.cumulativeCostUsd) || 0,
  };
}

// 실행자가 남긴 보고 문면을 꺼낸다. 없으면 빈 문자열이지 null이 아니다.
function executorReport(verification) {
  const checks = Array.isArray(verification?.checks) ? verification.checks : [];
  const failure = [...checks].reverse().find((check) => check?.executorFailure)?.executorFailure;
  return String(failure?.outputExcerpt ?? failure?.reason ?? '');
}

// 결과를 한 낱말로 요약한다. 턴이 모자라 죽은 것과 그냥 실패한 것을 구분한다.
function outcomeOf({ delivered, telemetry, verification }) {
  if (delivered && verification?.passed === true) return 'DELIVERED_AND_PASSED';
  if (delivered) return 'DELIVERED_BUT_FAILED';
  if (telemetry.terminalReason === TERMINAL_MAX_TURNS || telemetry.subtype === 'error_max_turns') return 'EXHAUSTED_TURNS_WITH_NOTHING';
  return 'NO_DELIVERABLE';
}

export class TurnBudgetObservationStore {
  constructor(dataDirectory) {
    this.path = path.join(dataDirectory, 'turn-budget-observations.jsonl');
    this.dataDirectory = dataDirectory;
  }

  // 관측 한 줄을 덧붙인다. 기록 실패가 실행을 죽이지는 않지만 삼키지도 않는다.
  async record(task) {
    const observation = observationFromTask(task);
    await mkdir(this.dataDirectory, { recursive: true }).catch(() => {});
    await appendFile(this.path, `${JSON.stringify(observation)}\n`, 'utf8');
    return observation;
  }

  // 쌓인 관측을 읽는다.
  async list({ limit = 500 } = {}) {
    const raw = await readFile(this.path, 'utf8').catch(() => '');
    return raw.split(/\r?\n/).filter(Boolean).slice(-Math.max(1, limit)).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  }

  // 예산이 모자랐던 실행과 충분했던 실행을 갈라 보여준다. 값을 제안하지는 않는다.
  async summary({ limit = 500 } = {}) {
    const observations = await this.list({ limit });
    const exhausted = observations.filter((item) => item.outcome === 'EXHAUSTED_TURNS_WITH_NOTHING');
    const delivered = observations.filter((item) => item.delivered);
    const turnsWhenDelivered = delivered.map((item) => item.maxTurns).filter((value) => Number.isFinite(value));
    const turnsWhenExhausted = exhausted.map((item) => item.maxTurns).filter((value) => Number.isFinite(value));
    return {
      observations: observations.length,
      delivered: delivered.length,
      exhaustedWithNothing: exhausted.length,
      maxTurnsSeenWhenExhausted: turnsWhenExhausted.length ? Math.max(...turnsWhenExhausted) : null,
      minTurnsSeenWhenDelivered: turnsWhenDelivered.length ? Math.min(...turnsWhenDelivered) : null,
      // 값을 정하기에 충분한 근거가 쌓였는지만 말한다. 하한 제안은 사람 몫이다.
      readyToChooseFloor: exhausted.length >= 3 && delivered.length >= 3,
    };
  }
}
