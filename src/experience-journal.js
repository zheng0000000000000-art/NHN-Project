import path from 'node:path';
import { appendJsonLine, nowIso, randomId, readJsonLines } from './utils.js';

export class ExperienceJournal {
  constructor(dataDirectory) {
    this.path = path.join(dataDirectory, 'experience-events.jsonl');
  }

  async record(actor, input) {
    const event = {
      id: randomId('exp_'),
      schemaVersion: 1,
      at: nowIso(),
      actorUserId: actor.id,
      goal: text(input.goal, 2000),
      outcome: text(input.outcome, 8000),
      verdict: normalizeVerdict(input.verdict),
      taskId: input.taskId ? String(input.taskId) : null,
      usedSkillIds: stringList(input.usedSkillIds, 40),
      usedHarnessIds: stringList(input.usedHarnessIds, 20),
      failureCaseIds: stringList(input.failureCaseIds, 50),
      discoveries: stringList(input.discoveries, 30, 2000),
      nextActions: stringList(input.nextActions, 30, 2000),
    };
    await appendJsonLine(this.path, event);
    return event;
  }

  async recent({ limit = 50 } = {}) {
    const events = await readJsonLines(this.path);
    return events.slice(-Math.max(1, Math.min(500, Number(limit) || 50))).reverse();
  }
}

function normalizeVerdict(value) {
  const verdict = String(value || 'UNKNOWN').toUpperCase();
  return ['PASSED', 'FAILED', 'PARTIAL', 'UNKNOWN'].includes(verdict) ? verdict : 'UNKNOWN';
}

function stringList(value, maxItems, maxLength = 200) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => text(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function text(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}
