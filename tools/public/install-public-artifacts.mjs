#!/usr/bin/env node
// Installs the public-asset reusable board artifacts as DRAFT / IMPORTED_LOCAL_SKILL.
// Mirrors tools/judging/install-criteria-artifacts.mjs. Program-native import path;
// activation stays admin-gated on purpose (P0 control).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(projectRoot, 'data'));
const actorId = process.env.PUBLIC_ARTIFACTS_ACTOR_ID || 'public-artifacts-system';
const now = new Date().toISOString();
mkdirSync(dataDir, { recursive: true });

const harnesses = [
  {
    id: 'public-asset-integrity',
    label: 'Public asset integrity',
    description: 'Fails on broken local references or orphaned js/css assets under public/.',
    commands: [{ file: 'node', args: ['tools/public/check-assets.mjs'], cwd: '.', expectedExit: 0, timeoutMs: 60000 }],
  },
];

const skills = [
  {
    id: 'board-task-spec-authoring',
    label: 'Board task spec (jisiseo) authoring',
    description: 'How to write a board task instruction the program can verify and any executor (including a small local model) can complete unattended.',
    rules: [
      'Set allowedPaths to the minimal glob set the change needs and nothing more; the claim-time scope lock and the SCOPE_VIOLATION gate both key off it, so an over-broad scope is itself a defect.',
      'Write acceptance criteria as observable end-states a program can check (files that must exist or be gone, references that must resolve, one exit-0 command), never as intentions; the executor never self-declares done, verify and review do.',
      'Name the harness/verificationProfile that actually executes the invariant the task asserts, and reuse an existing harness when one fits; a member or local-model task must use a safe profile, while a code-executing harness must be created and activated by an admin first.',
      'Make the spec self-contained: an executor with no prior context, including a small local model, should finish from the spec alone, so list the exact files, the exact expected final state, and the single command that proves it.',
      'Keep one task = one scope = one worktree; if a change spans overlapping paths, split it into non-overlapping tasks so parallel executors never collide.',
    ],
  },
];

const harnessDb = readJson(path.join(dataDir, 'harnesses.json'), { schemaVersion: 1, harnesses: [] });
for (const h of harnesses) upsert(harnessDb.harnesses, h, harnessFields);
harnessDb.harnesses.sort((a, b) => a.id.localeCompare(b.id));
writeJson(path.join(dataDir, 'harnesses.json'), harnessDb);

const skillDb = readJson(path.join(dataDir, 'skills.json'), { schemaVersion: 1, skills: [] });
for (const s of skills) upsert(skillDb.skills, s, skillFields);
skillDb.skills.sort((a, b) => a.id.localeCompare(b.id));
writeJson(path.join(dataDir, 'skills.json'), skillDb);

process.stdout.write(`Installed ${harnesses.length} harness draft(s) and ${skills.length} skill draft(s) into ${dataDir}\n`);

function harnessFields(input, next) {
  next.label = input.label; next.description = input.description; next.commands = input.commands;
  next.fixtureCandidates = next.fixtureCandidates ?? [];
  next.definitionSha256 = sha256(JSON.stringify({ id: next.id, label: next.label, description: next.description, commands: next.commands, sourceFailureCaseIds: next.sourceFailureCaseIds ?? [] }));
}
function skillFields(input, next) {
  next.label = input.label; next.description = input.description; next.rules = input.rules;
  next.definitionSha256 = sha256(JSON.stringify({ id: next.id, label: next.label, description: next.description, rules: next.rules, sourceFailureCaseIds: next.sourceFailureCaseIds ?? [] }));
}
function upsert(list, input, applyFields) {
  const existing = list.find((item) => item.id === input.id);
  const base = existing || { id: input.id, status: 'DRAFT', source: 'IMPORTED_LOCAL_SKILL', version: 0, sourceFailureCaseIds: [], createdByUserId: actorId, createdAt: now };
  const next = { ...base, updatedAt: now, version: existing ? Number(existing.version || 1) + 1 : 1 };
  applyFields(input, next);
  if (existing) Object.assign(existing, next); else list.push(next);
}
function readJson(file, fallback) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return structuredClone(fallback); } }
function writeJson(file, value) { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function sha256(value) { return createHash('sha256').update(String(value)).digest('hex'); }