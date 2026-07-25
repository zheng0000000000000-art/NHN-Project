import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AI_REVIEW_PLACEHOLDER_SUMMARY, citesChangedFile, isPlaceholderReviewSummary } from '../src/cli/main.js';

// 실측: 코덱스 리뷰가 프롬프트의 예시 줄을 그대로 돌려주어 APPROVE가 났다.
// summary는 자리표시자와 바이트 단위로 같았고 concerns는 비어 있었다.
const ECHOED = { verdict: 'APPROVE', summary: 'concise evidence-based summary', concerns: [] };

test('the example summary from the prompt is not a review', () => {
  assert.equal(isPlaceholderReviewSummary(ECHOED.summary), true);
  assert.equal(isPlaceholderReviewSummary(AI_REVIEW_PLACEHOLDER_SUMMARY), true);
  assert.equal(isPlaceholderReviewSummary('specific blocking item'), true,
    'the reject example is equally copyable');
});

test('an empty or whitespace summary is treated as no review at all', () => {
  assert.equal(isPlaceholderReviewSummary(''), true);
  assert.equal(isPlaceholderReviewSummary('   '), true);
  assert.equal(isPlaceholderReviewSummary(null), true);
  assert.equal(isPlaceholderReviewSummary(undefined), true);
});

test('casing and spacing do not smuggle the placeholder through', () => {
  assert.equal(isPlaceholderReviewSummary('Concise Evidence-Based Summary'), true);
  assert.equal(isPlaceholderReviewSummary('  concise   evidence-based   summary  '), true);
});

test('a real finding is accepted', () => {
  assert.equal(isPlaceholderReviewSummary('The diff retains the executor report under the 4000 character bound and the new test fails without it.'), false);
  assert.equal(isPlaceholderReviewSummary('Rejected: server.js writes an unbounded blob.'), false);
});

test('the prompt no longer offers a copyable summary, and the guard runs before the verdict is recorded', async () => {
  const source = await readFile('src/cli/main.js', 'utf8');
  assert.ok(!source.includes('"summary":"concise evidence-based summary"'),
    'the prompt must not hand the reviewer a summary it can paste back');
  const guardAt = source.indexOf('isPlaceholderReviewSummary(recommendation.summary)');
  const recordAt = source.indexOf("/ai-review`, {");
  assert.ok(guardAt > 0 && recordAt > 0);
  assert.ok(guardAt < recordAt, 'a copied review must be refused before it is recorded as a verdict');
});

test('the refusal is recorded as its own failure kind rather than passing quietly', async () => {
  const source = await readFile('src/cli/main.js', 'utf8');
  assert.match(source, /AI_REVIEW_SUMMARY_PLACEHOLDER/);
});

// 실측 2회차: 예시 문구를 바꾸자 리뷰어가 새 자리표시자를 그대로 베껴 통과했다.
// 문면을 열거하는 방식은 예시를 고칠 때마다 뚫린다.
test('a bracketed instruction is a placeholder whatever the wording inside it', () => {
  assert.equal(isPlaceholderReviewSummary('<your one-sentence finding>'), true);
  assert.equal(isPlaceholderReviewSummary('<blocking item>'), true);
  assert.equal(isPlaceholderReviewSummary('<anything the prompt happens to say next>'), true);
});

test('a placeholder left inside an otherwise real sentence is still refused', () => {
  assert.equal(isPlaceholderReviewSummary('The diff looks fine, <your one-sentence finding>'), true);
});

test('ordinary prose containing comparisons is not mistaken for a placeholder', () => {
  assert.equal(isPlaceholderReviewSummary('exit 0 < expected, so the gate blocked the change'), false);
  assert.equal(isPlaceholderReviewSummary('The retained excerpt is <= 4000 characters as required.'), false);
});

// 리뷰어가 diff를 열지 않고도 형식만 맞출 수 있었다. 계약을 "무엇을 봤는지 대라"로 바꾸고
// 그 이행을 프로그램이 판정한다.
test('a summary that names a changed file counts as citing evidence', () => {
  const changed = ['server.js', 'src/turn-budget-observations.js'];
  assert.equal(citesChangedFile('server.js now retains the executor report under a bound.', changed), true);
  assert.equal(citesChangedFile('turn-budget-observations.js reads both report sources.', changed), true,
    'naming the file without its directory is still naming it');
  assert.equal(citesChangedFile('SERVER.JS was changed', changed), true, 'casing must not reject an honest review');
});

test('a summary naming nothing that changed is not evidence', () => {
  assert.equal(citesChangedFile('The change looks correct and the tests pass.', ['server.js']), false);
  assert.equal(citesChangedFile('', ['server.js']), false);
});

test('a change set with no files cannot demand a citation', () => {
  assert.equal(citesChangedFile('nothing to inspect', []), true);
  assert.equal(citesChangedFile('nothing to inspect', undefined), true);
});

// 실측 3·4회차: 예시 요약을 지우자 내가 보여준 JSON 골격 줄을 그대로 냈다.
// 문면을 열거하는 대응은 예시를 고칠 때마다 뚫린다. 형식 자체를 프롬프트에서 없앤다.
test('the prompt hands the reviewer no output shape it could copy back', async () => {
  const source = await readFile('src/cli/main.js', 'utf8');
  assert.match(source, /Look at the work before deciding, and look at all of it/,
    'the reviewer must still be told how to look');
  assert.ok(!source.includes('TEAM_LOOP_REVIEW:'),
    'a marker contract is a string the reviewer can emit without reading the diff');
  assert.ok(!/'\s*\{"verdict"/.test(source), 'nor may the prompt show a JSON skeleton');
  assert.match(source, /the single word APPROVE or REJECT and nothing else on that line/);
  assert.match(source, /Write no JSON, no headings, and no code fences/);
});

test('the verdict is assembled by the program, not by the reviewer', async () => {
  const source = await readFile('src/cli/main.js', 'utf8');
  assert.match(source, /import \{ parseReviewProse, partitionChangedPaths \} from '\.\.\/review-contract\.js'/);
  assert.match(source, /const recommendation = parseReviewProse\(run\.output\)/);
  // 산문에서 못 뽑으면 조용히 통과시키지 않고 실패로 기록한다.
  assert.match(source, /AI_REVIEW_CONTRACT_MISSING/);
  assert.match(source, /AI_REVIEW_SUMMARY_CITES_NOTHING/);
});

test('the citation and placeholder guards still gate what the parser produced', async () => {
  const source = await readFile('src/cli/main.js', 'utf8');
  const parseAt = source.indexOf('const recommendation = parseReviewProse(run.output)');
  const guardAt = source.indexOf('isPlaceholderReviewSummary(recommendation.summary)');
  const recordAt = source.indexOf('/ai-review`, {');
  assert.ok(parseAt > 0 && guardAt > parseAt && recordAt > guardAt,
    'parse, then refuse, then record — in that order');
});

// 실측 6회차: 산문 계약으로 진짜 리뷰가 나왔으나 REJECT의 요약이 "무엇을 하는가"라
// 이유가 아니었다. concerns에 우려가 아닌 서술이 들어갔다.
test('the reviewer is asked for the reason for its verdict, not a description', async () => {
  const source = await readFile('src/cli/main.js', 'utf8');
  assert.match(source, /giving the reason for your/);
  assert.match(source, /when approving, what in that file satisfies the acceptance criteria/);
  assert.match(source, /rejecting, what about that file is wrong or missing/);
  assert.match(source, /it is the only sentence recorded/,
    'the reviewer must know the sentence stands alone');
});

// 실패한 리뷰만 원문을 남기면 승인 판정은 사후에 대조할 근거가 없다.
test('a completed review keeps the output that produced it, not only the verdict', async () => {
  const source = await readFile('src/cli/main.js', 'utf8');
  assert.match(source, /outputExcerpt: retainExecutorReport\(run\.output\)\?\.outputExcerpt \|\| ''/,
    'retainExecutorReport returns a record, not a string; storing the record yields "[object Object]"');
  const server = await readFile('server.js', 'utf8');
  // 구간을 좁히지 않으면 아래 review-failure 핸들러의 같은 문면을 잡고 통과한다.
  const recordAt = server.indexOf("action === 'ai-review'");
  const endAt = server.indexOf("action === 'review-failure'", recordAt);
  assert.ok(recordAt > 0 && endAt > recordAt);
  const handler = server.slice(recordAt, endAt);
  assert.match(handler, /outputExcerpt:/, 'the server must persist it alongside the verdict');
  assert.match(handler, /slice\(-EXECUTOR_REPORT_LIMIT\)/, 'bounded, like the executor report');
  // 실측 7회차: 근거 자리에 "[object Object]"가 저장됐다. 없는 근거보다 나쁘다.
  assert.match(handler, /typeof body\.outputExcerpt === 'string'/,
    'a non-string must be dropped rather than stringified into the evidence slot');
});

// 실측 8회차: 리뷰어가 새 파일을 못 보고 "테스트가 없다"고 거절했다. HEAD~1은 이 작업이
// 손대지 않은 커밋까지 보여주고, untracked 새 파일은 빠뜨린다.
test('the reviewer is pointed at this task change set, not at the previous commit', async () => {
  const source = await readFile('src/cli/main.js', 'utf8');
  assert.ok(!source.includes('git --no-pager diff HEAD~1'),
    'HEAD~1 shows commits this task never touched and hides its new files');
  assert.match(source, /git --no-pager diff HEAD --unified=3 -- \$\{changed\.modified\.join\(' '\)\}/);
  assert.match(source, /appear in no commit, so no diff will show them — open and read each one/);
});

test('the split between new and modified files is made by the program', async () => {
  const source = await readFile('src/cli/main.js', 'utf8');
  assert.match(source, /import \{ parseReviewProse, partitionChangedPaths \}/);
  assert.match(source, /const changed = await classifyChangedPaths\(workspace, task\.verification\?\.changedPaths \|\| \[\]\)/);
  // status를 못 읽었으면 새 파일이 없다고 단정하지 않고 그 사실을 리뷰어에게 말한다.
  assert.match(source, /statusRead: false/);
  assert.match(source, /Git status could not be read/);
});
