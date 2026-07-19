import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskSpecMarkdown, taskSpecFilename } from '../public/task-spec.js';

const task = {
  id: 'tsk_001',
  title: '[A02] 타이틀 화면과 경매장 입장 흐름',
  status: 'READY',
  priority: 300,
  assigneeUserId: 'usr_gd',
  reviewerUserId: 'usr_choi',
  description: '게임의 분위기와 행동을 먼저 전달한다.',
  acceptanceCriteria: ['5초 안에 목적을 이해한다', '입장하기가 주 행동이다'],
  allowedPaths: ['public/auction/ui/title.js', 'public/auction/ui/title.css'],
  verificationProfile: 'repository-basic',
  skillIds: ['scope-guard'],
  schedule: { plannedStart: '2026-07-20', plannedEnd: '2026-07-21', note: '2인 병렬 개발' },
};

const users = [
  { id: 'usr_gd', name: 'GD_JM' },
  { id: 'usr_choi', name: '최재혁' },
];

test('task specification contains ownership, schedule, scope and completion contract', () => {
  const markdown = buildTaskSpecMarkdown(task, users, new Date('2026-07-19T00:00:00.000Z'));
  assert.match(markdown, /담당자 \| GD_JM/);
  assert.match(markdown, /리뷰어 \| 최재혁/);
  assert.match(markdown, /2026-07-20/);
  assert.match(markdown, /5초 안에 목적을 이해한다/);
  assert.match(markdown, /public\/auction\/ui\/title\.js/);
  assert.match(markdown, /repository-basic/);
  assert.match(markdown, /skill:scope-guard/);
});

test('task specification filename is safe and readable', () => {
  const filename = taskSpecFilename({ title: 'A/B: 타이틀 화면?' });
  assert.equal(filename, 'A-B-타이틀-화면-작업-명세서.md');
});

test('task specification includes an actionable execution, evidence and review contract', () => {
  const markdown = buildTaskSpecMarkdown(task, users, new Date('2026-07-19T00:00:00.000Z'), {
    profiles: {
      'repository-basic': {
        label: 'Repository basic',
        description: '패치 무결성을 검사합니다.',
        commands: [{ file: 'git', args: ['diff', '--check'], expectedExit: 0 }],
      },
    },
    skills: [{ id: 'scope-guard', label: 'Scope guard', description: '범위 밖 변경을 방지합니다.' }],
  });
  assert.match(markdown, /## 3\. 완료 조건과 증거/);
  assert.match(markdown, /완료 조건별 증거 기록/);
  assert.match(markdown, /## 4\. 권장 실행 순서/);
  assert.match(markdown, /git diff --check/);
  assert.match(markdown, /Scope guard/);
  assert.match(markdown, /## 7\. 리뷰 체크리스트/);
  assert.match(markdown, /## 9\. 인계 기록/);
});
