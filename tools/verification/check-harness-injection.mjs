// 유휴 시간 장애주입 시뮬레이션: 하네스가 "통과한다"가 아니라 "막을 때 막는다"를 증명한다.
//
// 하네스가 exit 0을 내는 것은 아무것도 증명하지 않는다. 아무것도 검사하지 않는 하네스도 exit 0을 낸다.
// 알려진 결함을 실제로 주입해 exit 1이 뜨고, 되돌리면 다시 exit 0으로 돌아와야 그 하네스가 증명된다.
//
// 주입은 소스를 변형하므로 살아있는 트리에서 하면 안 된다. 전용 git worktree 스냅샷을 만들어
// 그 안에서만 변형하고, 끝나면 정리한다. 정리 실패는 조용히 삼키지 않는다.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const GIT = process.env.TEAM_LOOP_GIT_BIN || 'git';
const SANDBOX_DIR = '.team-loop-sandboxes';
const SANDBOX_NAME = 'harness-injection';
const HARNESS_TIMEOUT_MS = 120_000;
const OUTPUT_CAP_BYTES = 256 * 1024;

// 하네스별 장애주입 명세. mutate는 원문을 받아 결함이 심긴 원문을 돌려준다.
export const INJECTIONS = [
  {
    harness: 'tools/verification/check-token-efficiency.mjs',
    contract: 'context-size',
    name: 'context-budget-flattened',
    file: 'config/context-seeds.json',
    mutate(text) {
      const parsed = JSON.parse(text);
      const seeds = Array.isArray(parsed.seeds) ? parsed.seeds : Object.values(parsed.seeds ?? parsed);
      const single = seeds.find((seed) => seed.id === 'single-file');
      const implementation = seeds.find((seed) => seed.id === 'implementation');
      single.maxSourceCharacters = implementation.maxSourceCharacters;
      return JSON.stringify(parsed, null, 2);
    },
  },
  {
    harness: 'tools/verification/check-token-efficiency.mjs',
    contract: 'maximum-turns',
    name: 'turn-ceiling-removed',
    file: 'src/max-turn-decomposition.js',
    mutate: (text) => text.replace("return { action: 'DECOMPOSE', maxTurns: 12 };", "return { action: 'DECOMPOSE', maxTurns: 999 };"),
  },
  {
    harness: 'tools/verification/check-token-efficiency.mjs',
    contract: 'start-work-priority',
    name: 'review-outranks-ready',
    file: 'src/orchestration-engine.js',
    mutate: (text) => text.replace('{ IN_PROGRESS: 0, READY: 1, REVIEW: 2, BLOCKED: 3 }', '{ IN_PROGRESS: 0, REVIEW: 1, READY: 2, BLOCKED: 3 }'),
  },
  {
    harness: 'tools/verification/check-token-efficiency.mjs',
    contract: 'context-pack-receipts',
    name: 'receipt-drops-serialized-stage',
    file: 'src/context-packs.js',
    mutate: (text) => text.replace('serialized: true', 'serialized: false'),
  },
  {
    harness: 'tools/verification/check-loop-scenarios.mjs',
    contract: 'loop-scenarios',
    name: 'delivery-gate-mislabels-no-deliverable',
    file: 'src/delivery-gate.js',
    mutate: (text) => text.replace("failureKind: 'NO_DELIVERABLE',", "failureKind: 'DELIVERED_ANYWAY',"),
  },
  {
    harness: 'tools/verification/check-runtime.mjs',
    contract: 'runtime-boundary',
    name: 'browser-entry-imports-a-missing-module',
    file: 'public/app.js',
    mutate: (text) => `import './module-that-does-not-exist.js';\n${text}`,
  },
  {
    harness: 'tools/verification/check-writing.mjs',
    args: ['document'],
    contract: 'writing-review',
    name: 'unresolved-placeholder-left-in-a-document',
    file: 'docs/BALANCE-OPERATIONS.md',
    // 이 하네스는 "변경된" 문서만 본다. 변경이 없으면 검사 대상이 없어 실패하므로,
    // 기준선도 변경이어야 한다 — 결함만 없는 변경.
    mutate: (text) => `${text}\n\nTODO: 이 절은 추후 작성.\n`,
    baseline: (text) => `${text}\n\n운영 메모: 이 절은 회귀 기준선이다.\n`,
  },
  {
    harness: 'tools/verification/check-balance-gate.mjs',
    args: ['examples/balance/unknown-auction-economy.json', '--mode=evaluate'],
    contract: 'balance-gate',
    name: 'metric-target-made-unreachable',
    file: 'examples/balance/unknown-auction-economy.json',
    mutate(text) {
      const parsed = JSON.parse(text);
      const metric = parsed.spec.metrics[0];
      // 도달 불가능한 창으로 좁힌다. 게이트가 목표 미달을 잡아야 한다.
      metric.minimum = 1e9;
      metric.maximum = 1e9 + 1;
      return JSON.stringify(parsed, null, 2);
    },
  },
  {
    harness: 'tools/verification/check-context-pack.mjs',
    args: ['test/fixtures/context-pack/pack.json', '.'],
    contract: 'context-pack-integrity',
    name: 'declared-input-hash-goes-stale',
    file: 'test/fixtures/context-pack/pack.json',
    mutate(text) {
      const parsed = JSON.parse(text);
      parsed.contract.requiredInputs[0].sha256 = '0'.repeat(64);
      return JSON.stringify(parsed, null, 2);
    },
  },
];

// 샌드박스 주입으로는 증명할 수 없지만 다른 곳에서 적대적으로 증명된 하네스. 미증명과 섞지 않는다.
export const PROVEN_ELSEWHERE = {
  'tools/verification/check-integration-tree.mjs':
    'test/integration-tree.test.js — 임시 저장소에 충돌 마커를 커밋해 검출을 확인한다. '
    + '이 하네스는 설계상 자기가 실행된 트리가 아니라 메인 worktree를 검사하므로, 샌드박스에 심은 결함에는 닿지 않는다.',
  'tools/verification/check-harness-injection.mjs':
    'test/harness-injection.test.js — 아무것도 검사하지 않는 가짜 하네스를 MISSED로 잡아내는지 확인한다. '
    + '자기 자신을 샌드박스 안에서 다시 돌리면 중첩 실행이 되므로 주입 대상으로 삼지 않는다.',
};

// 주입 명세가 없어 아직 증명되지 않은 하네스. 목록을 손으로 들고 있지 않고 디렉터리에서 도출한다.
export function unprovenHarnesses(cwd = process.cwd(), injections = INJECTIONS) {
  const directory = path.join(cwd, 'tools', 'verification');
  const covered = new Set([...injections.map((item) => item.harness), ...Object.keys(PROVEN_ELSEWHERE)]);
  return readdirSync(directory)
    .filter((name) => name.startsWith('check-') && name.endsWith('.mjs'))
    .map((name) => path.posix.join('tools', 'verification', name))
    .filter((relative) => !covered.has(relative))
    .sort();
}

// 진행 중인 태스크 worktree가 있으면 유휴가 아니다. 무엇을 근거로 판정했는지 같이 돌려준다.
export function detectIdle(cwd = process.cwd()) {
  let listed = '';
  try {
    listed = execFileSync(GIT, ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf8' });
  } catch {
    return { idle: false, reason: 'WORKTREE_LIST_UNAVAILABLE', activeWorktrees: [] };
  }
  const activeWorktrees = listed.split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
    .filter((entry) => entry.includes('.team-loop-worktrees'));
  return {
    idle: activeWorktrees.length === 0,
    reason: activeWorktrees.length ? 'TASK_WORKTREE_ACTIVE' : null,
    activeWorktrees,
  };
}

// 커밋되지 않은 변경은 HEAD 스냅샷에 없다. 검사되지 않았다는 사실을 보고에 남긴다.
export function untestedChanges(cwd = process.cwd()) {
  try {
    return execFileSync(GIT, ['status', '--porcelain'], { cwd, encoding: 'utf8' })
      .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// 전용 worktree 스냅샷을 만든다. 살아있는 트리는 건드리지 않는다.
export function createSandbox(cwd, name = SANDBOX_NAME) {
  const root = path.join(cwd, SANDBOX_DIR, name);
  removeSandbox(cwd, name, { force: true });
  execFileSync(GIT, ['worktree', 'add', '--detach', '--quiet', root, 'HEAD'], { cwd, encoding: 'utf8' });
  const baseFingerprint = execFileSync(GIT, ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  return { root, baseFingerprint };
}

// 정리한다. 실패하면 삼키지 않고 사유를 돌려준다.
export function removeSandbox(cwd, name = SANDBOX_NAME, { force = false } = {}) {
  const root = path.join(cwd, SANDBOX_DIR, name);
  if (!existsSync(root) && !force) return { removed: false, error: null };
  try {
    execFileSync(GIT, ['worktree', 'remove', '--force', root], { cwd, stdio: 'ignore' });
    return { removed: true, error: null };
  } catch (error) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* 아래에서 보고한다 */ }
    try { execFileSync(GIT, ['worktree', 'prune'], { cwd, stdio: 'ignore' }); } catch { /* 위와 같다 */ }
    if (existsSync(root)) return { removed: false, error: String(error.message || error).slice(0, 300) };
    return { removed: true, error: null };
  }
}

// 하네스를 제한된 환경에서 실행한다. timeout과 출력 상한 위반은 통과로 세지 않는다.
function runHarness(harness, cwd, args = []) {
  const result = spawnSync(process.execPath, [harness, ...args], {
    cwd, encoding: 'utf8', timeout: HARNESS_TIMEOUT_MS, maxBuffer: OUTPUT_CAP_BYTES,
  });
  if (result.error) return { exit: 1, violation: String(result.error.code || result.error.message) };
  return { exit: Number(result.status ?? 1), violation: null };
}

// 샌드박스 안에서 결함 하나를 주입하고, 잡히는지 확인한 뒤 되돌린다.
export function runInjection(injection, sandboxRoot) {
  const target = path.join(sandboxRoot, injection.file);
  if (!existsSync(target)) {
    // 스냅샷은 HEAD다. 아직 커밋되지 않은 대상은 결함이 아니라 명세 문제로 보고한다.
    return { ...injection, caught: false, detail: `target is absent from the HEAD snapshot: ${injection.file}` };
  }
  const original = readFileSync(target, 'utf8');
  const mutated = injection.mutate(original);
  if (mutated === original) {
    return { ...injection, caught: false, detail: 'the mutation changed nothing; the injection spec is stale' };
  }
  const args = injection.args ?? [];
  // 변경이 존재해야만 돌아가는 하네스가 있다. 그런 하네스의 기준선은 원본이 아니라
  // "결함 없는 변경"이다. baseline이 없으면 원본으로 되돌린다.
  const baseline = injection.baseline ? injection.baseline(original) : original;
  let injected = { exit: null, violation: null };
  try {
    writeFileSync(target, mutated, 'utf8');
    injected = runHarness(injection.harness, sandboxRoot, args);
  } finally {
    writeFileSync(target, baseline, 'utf8');
  }
  const restored = runHarness(injection.harness, sandboxRoot, args);
  return {
    ...injection,
    injectedExit: injected.exit,
    restoredExit: restored.exit,
    violation: injected.violation || restored.violation || null,
    caught: injected.exit !== 0 && restored.exit === 0,
    detail: injected.exit === 0
      ? 'the harness passed while the fault was present'
      : restored.exit !== 0
        ? 'the harness stayed red after the fault was reverted'
        : null,
  };
}

// 샌드박스를 세우고 모든 주입을 돌린다. 실패하면 조사할 수 있게 샌드박스를 남긴다.
export function simulateInjections(cwd = process.cwd(), injections = INJECTIONS, { requireIdle = false } = {}) {
  const idle = detectIdle(cwd);
  const unproven = unprovenHarnesses(cwd, injections);
  if (requireIdle && !idle.idle) {
    return { skipped: true, idle, untested: [], sandbox: null, results: [], proven: [], unproven, cleanup: null };
  }
  const sandbox = createSandbox(cwd);
  let results = [];
  let cleanup = null;
  try {
    results = injections.map((injection) => runInjection(injection, sandbox.root));
  } finally {
    // 결과가 나쁘면 남긴다: 조사 대상 workspace를 무조건 지우지 않는다.
    cleanup = results.length && results.every((item) => item.caught)
      ? removeSandbox(cwd)
      : { removed: false, error: null, preserved: sandbox.root };
  }
  return {
    skipped: false,
    idle,
    untested: untestedChanges(cwd),
    sandbox,
    results,
    proven: [...new Set(results.filter((item) => item.caught).map((item) => item.harness))],
    unproven,
    cleanup,
  };
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (invokedDirectly) {
  const requireIdle = process.argv.includes('--require-idle');
  const report = simulateInjections(process.cwd(), INJECTIONS, { requireIdle });
  if (report.skipped) {
    console.error(`Skipped: the workspace is not idle (${report.idle.reason}).`);
    report.idle.activeWorktrees.forEach((entry) => console.error(`  - ${entry}`));
    process.exit(1);
  }
  console.log(`Sandbox ${report.sandbox.root} at ${report.sandbox.baseFingerprint}`);
  report.results.forEach((item) => {
    const mark = item.caught ? 'caught' : 'MISSED';
    console.log(`  [${mark}] ${item.contract} / ${item.name} -> injected exit ${item.injectedExit}, restored exit ${item.restoredExit}`);
  });
  if (report.untested.length) {
    console.log(`Not covered by this run (${report.untested.length} uncommitted change(s); the sandbox is a HEAD snapshot):`);
    report.untested.slice(0, 10).forEach((entry) => console.log(`  - ${entry}`));
  }
  const provenElsewhere = Object.entries(PROVEN_ELSEWHERE);
  if (provenElsewhere.length) {
    console.log('Proven by a dedicated adversarial test instead of sandbox injection:');
    provenElsewhere.forEach(([harness, why]) => console.log(`  - ${harness}: ${why}`));
  }
  if (report.unproven.length) {
    console.log('Unproven harnesses (no failure injection specified yet):');
    report.unproven.forEach((entry) => console.log(`  - ${entry}`));
  }
  if (report.cleanup?.preserved) {
    console.error(`Sandbox preserved for inspection: ${report.cleanup.preserved}`);
  } else if (report.cleanup && !report.cleanup.removed) {
    console.error(`Sandbox cleanup failed: ${report.cleanup.error}`);
  }
  const missed = report.results.filter((item) => !item.caught);
  if (missed.length || (report.cleanup && !report.cleanup.removed && !report.cleanup.preserved)) {
    missed.forEach((item) => console.error(`  - ${item.contract} / ${item.name}: ${item.detail}`));
    process.exit(1);
  }
  console.log(`Harness injection simulation passed: ${report.results.length} faults injected, all caught, sandbox cleaned.`);
}
