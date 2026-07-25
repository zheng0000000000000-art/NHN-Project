// 통합 트리(메인 worktree)가 머지 중이거나 충돌 마커를 품고 있으면 exit 1로 막는다.
// 태스크 검증은 자기 worktree에서만 돌기 때문에, 머지되는 쪽이 깨져도 통과한다. 그 구멍을 닫는다.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const GIT = process.env.TEAM_LOOP_GIT_BIN || 'git';
const IN_PROGRESS_MARKERS = ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];
const IN_PROGRESS_DIRS = ['rebase-merge', 'rebase-apply'];

// git을 실행하고 stdout을 돌려준다. 실패해도 던지지 않고 null을 준다.
function git(args, cwd) {
  try {
    return execFileSync(GIT, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
}

// worktree 목록의 첫 항목이 통합 트리다.
export function mainWorktree(cwd = process.cwd()) {
  const listed = git(['worktree', 'list', '--porcelain'], cwd);
  if (!listed) return null;
  const first = listed.split(/\r?\n/).find((line) => line.startsWith('worktree '));
  return first ? first.slice('worktree '.length).trim() : null;
}

// 진행 중인 머지/리베이스/체리픽 흔적을 모은다.
export function inProgressOperations(gitDir) {
  if (!gitDir) return [];
  const found = [];
  for (const marker of IN_PROGRESS_MARKERS) {
    if (existsSync(path.join(gitDir, marker))) found.push(marker);
  }
  for (const directory of IN_PROGRESS_DIRS) {
    if (existsSync(path.join(gitDir, directory))) found.push(directory);
  }
  return found;
}

// 추적 중인 파일에서 충돌 마커 줄을 찾는다.
export function conflictMarkerHits(cwd) {
  const found = git(['grep', '-n', '-E', '^(<<<<<<<|>>>>>>>) ', '--', '.'], cwd);
  if (!found) return [];
  return found.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

// 수집한 사실을 사람이 읽을 수 있는 위반 목록으로 바꾼다. 판정 로직은 여기만 본다.
export function integrationProblems({ operations = [], hits = [] } = {}) {
  const problems = [];
  if (operations.length) {
    problems.push(`unfinished git operation in the integration tree: ${operations.join(', ')}`);
  }
  for (const hit of hits) {
    problems.push(`conflict marker committed into a tracked file: ${hit}`);
  }
  return problems;
}

// 통합 트리를 실제로 조사해 위반 목록을 만든다.
export function inspectIntegrationTree(cwd = process.cwd()) {
  const root = mainWorktree(cwd);
  if (!root) return { root: null, problems: ['integration tree could not be resolved; is this a git repository?'] };
  const gitDir = git(['rev-parse', '--absolute-git-dir'], root)?.trim() ?? null;
  return {
    root,
    problems: integrationProblems({
      operations: inProgressOperations(gitDir),
      hits: conflictMarkerHits(root),
    }),
  };
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (invokedDirectly) {
  const { root, problems } = inspectIntegrationTree();
  if (problems.length) {
    console.error(`Integration tree is not clean: ${root ?? 'unknown'}`);
    problems.forEach((problem) => console.error(`  - ${problem}`));
    process.exit(1);
  }
  console.log(`Integration tree is clean: ${root}`);
}
