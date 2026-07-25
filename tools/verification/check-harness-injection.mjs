// 유휴 시간 장애주입 시뮬레이션: 하네스가 "통과한다"가 아니라 "막을 때 막는다"를 증명한다.
//
// 하네스가 exit 0을 내는 것은 아무것도 증명하지 않는다. 아무것도 검사하지 않는 하네스도 exit 0을 낸다.
// 각 하네스마다 알려진 결함을 실제로 주입해 exit 1이 뜨는지 확인하고, 되돌린 뒤 다시 exit 0으로
// 돌아오는지 확인해야 그 하네스가 증명된 것이다. 주입 명세가 없는 하네스는 미증명으로 보고한다.
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const GIT = process.env.TEAM_LOOP_GIT_BIN || 'git';

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
    harness: 'tools/verification/check-integration-tree.mjs',
    contract: 'integration-tree',
    name: 'conflict-marker-committed',
    file: 'README.md',
    mutate: (text) => `${text}\n<<<<<<< HEAD\n`,
  },
];

// 주입 명세가 없어 아직 증명되지 않은 하네스. 숨기지 않고 드러낸다.
export function unprovenHarnesses(cwd = process.cwd(), injections = INJECTIONS) {
  const directory = path.join(cwd, 'tools', 'verification');
  const covered = new Set(injections.map((item) => item.harness));
  return readdirSync(directory)
    .filter((name) => name.startsWith('check-') && name.endsWith('.mjs'))
    .map((name) => path.posix.join('tools', 'verification', name))
    .filter((relative) => !covered.has(relative))
    .sort();
}

// 하네스를 실행하고 exit code를 돌려준다.
function runHarness(harness, cwd) {
  const result = spawnSync(process.execPath, [harness], { cwd, encoding: 'utf8' });
  return Number(result.status ?? 1);
}

// 대상 파일이 이미 수정돼 있으면 주입을 거부한다. 남의 변경을 되돌려 덮어쓰지 않기 위해서다.
function dirtyTargets(files, cwd) {
  try {
    const status = execFileSync(GIT, ['status', '--porcelain', '--', ...files], { cwd, encoding: 'utf8' });
    return status.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// 하나의 주입을 수행하고 결과를 돌려준다. 원문 복원은 finally에서 보장한다.
export function runInjection(injection, cwd) {
  const target = path.join(cwd, injection.file);
  const original = readFileSync(target, 'utf8');
  const mutated = injection.mutate(original);
  if (mutated === original) {
    return { ...injection, caught: false, detail: 'the mutation changed nothing; the injection spec is stale' };
  }
  let injectedExit = null;
  try {
    writeFileSync(target, mutated, 'utf8');
    injectedExit = runHarness(injection.harness, cwd);
  } finally {
    writeFileSync(target, original, 'utf8');
  }
  const restoredExit = runHarness(injection.harness, cwd);
  return {
    ...injection,
    injectedExit,
    restoredExit,
    caught: injectedExit !== 0 && restoredExit === 0,
    detail: injectedExit === 0
      ? 'the harness passed while the fault was present'
      : restoredExit !== 0
        ? 'the harness stayed red after the fault was reverted'
        : null,
  };
}

// 모든 주입을 돌려 증명/미증명을 집계한다.
export function simulateInjections(cwd = process.cwd(), injections = INJECTIONS) {
  const files = [...new Set(injections.map((item) => item.file))];
  const dirty = dirtyTargets(files, cwd);
  if (dirty.length) {
    return { skipped: true, dirty, results: [], proven: [], unproven: unprovenHarnesses(cwd, injections) };
  }
  const results = injections.map((injection) => runInjection(injection, cwd));
  return {
    skipped: false,
    dirty: [],
    results,
    proven: [...new Set(results.filter((item) => item.caught).map((item) => item.harness))],
    unproven: unprovenHarnesses(cwd, injections),
  };
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (invokedDirectly) {
  const report = simulateInjections();
  if (report.skipped) {
    console.error('Refusing to inject faults while the target files have uncommitted changes:');
    report.dirty.forEach((entry) => console.error(`  - ${entry}`));
    process.exit(1);
  }
  const missed = report.results.filter((item) => !item.caught);
  report.results.forEach((item) => {
    const mark = item.caught ? 'caught' : 'MISSED';
    console.log(`  [${mark}] ${item.contract} / ${item.name} -> injected exit ${item.injectedExit}, restored exit ${item.restoredExit}`);
  });
  if (report.unproven.length) {
    console.log('Unproven harnesses (no failure injection specified yet):');
    report.unproven.forEach((entry) => console.log(`  - ${entry}`));
  }
  if (missed.length) {
    console.error(`Harness injection simulation failed (${missed.length} fault(s) not caught):`);
    missed.forEach((item) => console.error(`  - ${item.contract} / ${item.name}: ${item.detail}`));
    process.exit(1);
  }
  console.log(`Harness injection simulation passed: ${report.results.length} faults injected, all caught.`);
}
