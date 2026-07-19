import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const execFile = promisify(execFileCallback);
const mode = String(process.argv[2] || 'document').toLowerCase();
if (!['document', 'brainstorm'].includes(mode)) throw new Error('Usage: check-writing.mjs document|brainstorm');
const files = await changedWritingFiles(process.cwd(), mode);
if (!files.length) throw new Error('No changed Markdown document found.');
const failures = [];
for (const file of files) {
  const text = await readFile(path.resolve(file), 'utf8');
  await checkCommon(file, text, failures);
  if (mode === 'brainstorm') checkBrainstorm(file, text, failures);
}
if (failures.length) throw new Error(`Writing verification failed:\n- ${failures.join('\n- ')}`);
process.stdout.write(`${mode} review passed for ${files.length} file(s): ${files.join(', ')}\n`);

async function checkCommon(file, text, output) {
  if (text.trim().length < 80) output.push(`${file}: content is too short to review`);
  if (!/^#{1,3}\s+\S+/m.test(text)) output.push(`${file}: add a clear Markdown heading`);
  if (/\b(?:TODO|TBD|FIXME|PLACEHOLDER)\b|작성\s*예정|추후\s*작성/i.test(text)) output.push(`${file}: unresolved placeholder found`);
  if (/^(?:<{7}|={7}|>{7})/m.test(text)) output.push(`${file}: merge conflict marker found`);
  for (const target of [...text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((item) => item[1])) {
    if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
    try { await readFile(path.resolve(path.dirname(file), target.split('#')[0])); } catch { output.push(`${file}: broken relative link ${target}`); }
  }
}

function checkBrainstorm(file, text, output) {
  const role = brainstormRole(file);
  if (role === 'run') return requireSections(file, text, output, [['검증 기록', 'verification'], ['변경 파일', 'changed files']]);
  if (role === 'decision') return requireSections(file, text, output, [['상태', 'status'], ['열린 질문', 'open questions'], ['재개 조건', 'revisit', 'resume']]);
  if (role === 'candidate') return requireSections(file, text, output, [
    ['기준 명세 영향', 'spec impact'], ['한 문장 정의', 'one-line'], ['핵심 루프', 'core loop'],
    ['가장 강한 반론', 'strongest objection'], ['예상 실패', 'failure mode'], ['검증', 'verification'],
    ['플레이테스트', 'playtest'], ['열린 질문', 'open questions'],
  ]);
  if (role === 'comparison') return requireSections(file, text, output, [
    ['비교', 'comparison'], ['기준 명세', 'spec'], ['충돌', 'conflict'], ['공통 실패', 'common failure'], ['답할 수 없는 질문', 'open questions'],
  ]);
  if (role === 'recommendation') {
    requireSections(file, text, output, [
      ['제품 방향 판단', 'product direction'], ['다음 실험 추천', 'next experiment'],
      ['가장 강한 반론', 'strongest objection'], ['차선', 'runner-up'], ['뒤집', 'change the recommendation'],
    ]);
    if (!/(?:RECOMMENDED|CONDITIONAL|TIED|INSUFFICIENT_EVIDENCE|PROTOTYPE_REQUIRED|RESEARCH_REQUIRED)/.test(text)) output.push(`${file}: product direction must use an allowed recommendation status`);
    return;
  }
  const ideas = (text.match(/^\s*(?:[-*]|\d+\.)\s+\S+/gm) || []).length;
  if (ideas < 3) output.push(`${file}: brainstorm needs at least three explicit ideas`);
  if (!/(위험|반론|단점|risk|counter|objection)/i.test(text)) output.push(`${file}: include risks or counterarguments`);
  if (!/(선택|보류|탈락|다음\s*실험|열린\s*질문|decision|defer|open question|next experiment)/i.test(text)) output.push(`${file}: record synthesis or open questions`);
}

function brainstormRole(file) {
  const normalized = file.replaceAll('\\', '/').toLowerCase();
  const name = path.basename(normalized);
  if (normalized.includes('/candidates/') && !/template/.test(name)) return 'candidate';
  if (/comparison\.mdx?$/.test(name)) return 'comparison';
  if (/recommendation\.mdx?$/.test(name)) return 'recommendation';
  if (/decision\.mdx?$/.test(name)) return 'decision';
  if (/run\.mdx?$/.test(name)) return 'run';
  return 'general';
}

function requireSections(file, text, output, groups) {
  for (const alternatives of groups) if (!alternatives.some((value) => text.toLowerCase().includes(value.toLowerCase()))) output.push(`${file}: missing role section (${alternatives.join(' / ')})`);
}

async function changedWritingFiles(root, selectedMode) {
  // Deleted documents have no contents to review. Excluding D here also prevents
  // replacement/consolidation changes from failing with ENOENT while keeping renamed,
  // copied, modified, and newly added documents in the review set.
  const commands = [['diff', '--diff-filter=ACMRTUXB', '--name-only', 'HEAD'], ['diff', '--cached', '--diff-filter=ACMRTUXB', '--name-only', 'HEAD'], ['ls-files', '--others', '--exclude-standard']];
  const names = [];
  for (const args of commands) {
    try { names.push(...(await execFile('git', args, { cwd: root, windowsHide: true })).stdout.split(/\r?\n/)); }
    catch (error) { if (!args.includes('HEAD')) throw error; }
  }
  return [...new Set(names.map((item) => item.trim().replaceAll('\\', '/')).filter((item) => {
    if (!item) return false;
    if (selectedMode === 'brainstorm' && item.toLowerCase().includes('/evidence/')) return false;
    return selectedMode === 'brainstorm' ? /\.(?:md|mdx)$/i.test(item) : /\.(?:md|mdx|txt|rst)$/i.test(item);
  }))];
}
