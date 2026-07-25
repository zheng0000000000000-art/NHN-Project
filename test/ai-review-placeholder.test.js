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

test('the prompt tells the reviewer the command to run and what the summary must name', async () => {
  const source = await readFile('src/cli/main.js', 'utf8');
  assert.match(source, /git --no-pager diff HEAD~1/, 'the reviewer must be told how to look');
  assert.match(source, /must name at least one changed file/);
  assert.match(source, /AI_REVIEW_SUMMARY_CITES_NOTHING/);
});
