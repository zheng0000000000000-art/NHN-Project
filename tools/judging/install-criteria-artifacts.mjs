#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(projectRoot, 'data'));
const actorId = process.env.CRITERIA_ACTOR_ID || 'criteria-system';
const now = new Date().toISOString();

mkdirSync(dataDir, { recursive: true });

const harnesses = [
  {
    id: 'judging-submission-integrity',
    label: 'Judging T0 submission integrity',
    description: 'Checks required files, forbidden executable artifacts, configured video path, and configured run link.',
    commands: [{ file: 'node', args: ['tools/judging/check-criteria.mjs', 'integrity', '--strict'], cwd: '.', expectedExit: 0, timeoutMs: 120000 }],
  },
  {
    id: 'judging-repository-history',
    label: 'Judging T4 repository history',
    description: 'Checks commit count, contributor evidence, documentation presence, and obvious secret leakage.',
    commands: [{ file: 'node', args: ['tools/judging/check-criteria.mjs', 'repo-history'], cwd: '.', expectedExit: 0, timeoutMs: 120000 }],
  },
  {
    id: 'judging-ops-stability',
    label: 'Judging T5 cost and stability',
    description: 'Checks test/check script, operational documentation, and optional health URL availability.',
    commands: [{ file: 'node', args: ['tools/judging/check-criteria.mjs', 'ops-stability'], cwd: '.', expectedExit: 0, timeoutMs: 120000 }],
  },
];

const skills = [
  {
    id: 'judging-video-clarity',
    label: 'Judging T1 video clarity',
    description: 'Review rule for the 60-second silent-video pitch.',
    rules: [
      'The first 30 seconds must show the game genre, core loop, and AI-driven difference without verbal explanation.',
      'Prefer real gameplay over logos, menus, or slides; the AI-driven event should appear early enough that a silent viewer notices it.',
      'Validate the final cut with 5-10 people watching silently; AI structure review alone is not enough for surprise or fun.',
    ],
  },
  {
    id: 'judging-ai-native-gameplay',
    label: 'Judging T2 AI-native gameplay',
    description: 'Review rule for proving AI is part of the playable fun, not only a production tool.',
    rules: [
      'Show that runtime AI output changes game state, player options, NPC behavior, level generation, or win/loss structure.',
      'Compare AI-on and AI-off runs; if the core play pattern barely changes, treat AI-native score as weak.',
      'Separate objective AI dependency from subjective fun; human playtests must judge whether the AI change is enjoyable.',
    ],
  },
  {
    id: 'judging-technical-documentation',
    label: 'Judging T3 technical documentation',
    description: 'Review rule for technical documents that prove design quality.',
    rules: [
      'The document must explain architecture, model/data flow, prompts as design components, validation, failure modes, fallback, cost, latency, and privacy risks.',
      'Reject prompt-list-only documentation; require code/document/execution-result consistency.',
      'Ask whether the team can explain and modify the design under time pressure; plausible generated prose is not enough.',
    ],
  },
  {
    id: 'judging-nhn-fit-human-review',
    label: 'Judging T6 NHN fit human review',
    description: 'Review rule for keeping NHN alignment as advisory, not an automated pass/fail.',
    rules: [
      'AI may compare genre, service direction, and hiring signals, but must label NHN fit as advisory evidence only.',
      'Final NHN alignment judgment belongs to human reviewers because internal priorities and taste are not observable.',
      'Use this criterion as a tie-breaker or positioning guide, not as a deterministic elimination harness.',
    ],
  },
];

const harnessDb = readJson(path.join(dataDir, 'harnesses.json'), { schemaVersion: 1, harnesses: [] });
for (const harness of harnesses) upsertHarness(harnessDb, harness);
writeJson(path.join(dataDir, 'harnesses.json'), harnessDb);

const skillDb = readJson(path.join(dataDir, 'skills.json'), { schemaVersion: 1, skills: [] });
for (const skill of skills) upsertSkill(skillDb, skill);
writeJson(path.join(dataDir, 'skills.json'), skillDb);

process.stdout.write(`Installed ${harnesses.length} judging harness drafts and ${skills.length} judging skill drafts into ${dataDir}\n`);

function upsertHarness(db, input) {
  const existing = db.harnesses.find((item) => item.id === input.id);
  const base = existing || {
    id: input.id,
    status: 'DRAFT',
    source: 'IMPORTED_LOCAL_SKILL',
    version: 0,
    fixtureCandidates: [],
    createdByUserId: actorId,
    createdAt: now,
    lastTest: null,
  };
  const next = {
    ...base,
    label: input.label,
    description: input.description,
    commands: input.commands,
    updatedAt: now,
    version: existing ? Number(existing.version || 1) + 1 : 1,
  };
  next.definitionSha256 = sha256(JSON.stringify({
    id: next.id,
    label: next.label,
    description: next.description,
    commands: next.commands,
    sourceFailureCaseIds: next.sourceFailureCaseIds ?? [],
  }));
  if (existing) Object.assign(existing, next);
  else db.harnesses.push(next);
  db.harnesses.sort((a, b) => a.id.localeCompare(b.id));
}

function upsertSkill(db, input) {
  const existing = db.skills.find((item) => item.id === input.id);
  const base = existing || {
    id: input.id,
    status: 'DRAFT',
    source: 'IMPORTED_LOCAL_SKILL',
    version: 0,
    sourceFailureCaseIds: [],
    createdByUserId: actorId,
    createdAt: now,
  };
  const next = {
    ...base,
    label: input.label,
    description: input.description,
    rules: input.rules,
    updatedAt: now,
    version: existing ? Number(existing.version || 1) + 1 : 1,
  };
  next.definitionSha256 = sha256(JSON.stringify({
    id: next.id,
    label: next.label,
    description: next.description,
    rules: next.rules,
    sourceFailureCaseIds: next.sourceFailureCaseIds,
  }));
  if (existing) Object.assign(existing, next);
  else db.skills.push(next);
  db.skills.sort((a, b) => a.id.localeCompare(b.id));
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return structuredClone(fallback);
  }
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}
