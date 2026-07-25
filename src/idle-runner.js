// 유휴일 때만 도는 무비용 검증 작업을 돌린다.
//
// 자동 실행이 허용되는 조건은 좁다: 로컬이고, 되돌릴 수 있고, 스냅샷이 있고, 외부 비용이 없어야 한다.
// 장애주입 시뮬레이션은 그 조건을 전부 만족한다 — 전용 worktree 안에서만 변형하고 토큰을 쓰지 않는다.
// 그래도 실행 중인 작업과 경쟁하면 안 되므로, 유휴 판정은 프록시가 아니라 호출자가 주입한
// 권위 있는 신호로 한다.

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MIN_GAP_MS = 30 * 60_000;

export class IdleRunner {
  constructor({
    name,
    isIdle,
    run,
    intervalMs = DEFAULT_INTERVAL_MS,
    minGapMs = DEFAULT_MIN_GAP_MS,
    now = () => Date.now(),
    onResult = null,
  }) {
    if (typeof isIdle !== 'function') throw new Error('IdleRunner requires an isIdle probe.');
    if (typeof run !== 'function') throw new Error('IdleRunner requires a run function.');
    this.name = String(name || 'idle-job');
    this.isIdle = isIdle;
    this.run = run;
    this.intervalMs = Math.max(1_000, Number(intervalMs) || DEFAULT_INTERVAL_MS);
    this.minGapMs = Math.max(0, Number(minGapMs) || 0);
    this.now = now;
    this.onResult = onResult;
    this.timer = null;
    this.running = false;
    this.lastRunAt = null;
    this.lastOutcome = null;
    this.consecutiveFailures = 0;
  }

  // 한 번 평가한다. 돌았는지와 그 이유를 항상 돌려준다.
  async tick() {
    if (this.running) return this.#record({ ran: false, reason: 'ALREADY_RUNNING' });
    const gap = this.lastRunAt === null ? Infinity : this.now() - this.lastRunAt;
    if (gap < this.minGapMs) return this.#record({ ran: false, reason: 'TOO_SOON', waitedMs: gap });
    // 자리를 동기적으로 선점한다. await를 지난 뒤에 세우면 그 사이에 다른 tick이 가드를 통과한다.
    this.running = true;
    let idle;
    try {
      idle = await this.isIdle();
    } catch (error) {
      this.running = false;
      return this.#record({ ran: false, reason: 'IDLE_PROBE_FAILED', error: error instanceof Error ? error.message : String(error) });
    }
    if (!idle?.idle) {
      this.running = false;
      return this.#record({ ran: false, reason: 'BUSY', detail: idle?.reason ?? null });
    }

    const startedAt = this.now();
    try {
      const result = await this.run();
      this.consecutiveFailures = result?.ok === false ? this.consecutiveFailures + 1 : 0;
      return this.#record({ ran: true, reason: 'RAN', result, startedAt, finishedAt: this.now() });
    } catch (error) {
      this.consecutiveFailures += 1;
      return this.#record({
        ran: true,
        reason: 'THREW',
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        finishedAt: this.now(),
      });
    } finally {
      this.running = false;
      this.lastRunAt = this.now();
    }
  }

  // 주기 평가를 시작한다. 타이머는 프로세스를 붙잡지 않는다.
  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  // 주기 평가를 멈춘다.
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this;
  }

  // 관찰 가능한 현재 상태.
  status() {
    return {
      name: this.name,
      running: this.running,
      scheduled: Boolean(this.timer),
      intervalMs: this.intervalMs,
      minGapMs: this.minGapMs,
      lastRunAt: this.lastRunAt,
      lastOutcome: this.lastOutcome,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  // 결과를 기록하고 통지한다. 조용히 삼키지 않는다.
  #record(outcome) {
    const stamped = { name: this.name, at: this.now(), ...outcome };
    this.lastOutcome = stamped;
    try { this.onResult?.(stamped); } catch { /* 통지 실패가 작업을 죽이지 않는다 */ }
    return stamped;
  }
}
