#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeContextPackContract } from '../../src/contracts.js';

const [, , packArgument, rootArgument = '.'] = process.argv;

if (!packArgument) {
  console.error('Usage: node tools/verification/check-context-pack.mjs <pack.json> [workspace-root]');
  process.exitCode = 2;
} else {
  try {
    const workspaceRoot = path.resolve(rootArgument);
    const packPath = resolveInside(workspaceRoot, packArgument);
    const source = JSON.parse(await readFile(packPath, 'utf8'));
    const contract = normalizeContextPackContract(source.contract ?? source);
    const failures = [];

    for (const input of contract.requiredInputs) {
      const inputPath = resolveInside(workspaceRoot, input.path);
      const bytes = await readFile(inputPath).catch(() => null);
      if (!bytes) {
        failures.push({ path: input.path, reason: 'missing' });
        continue;
      }
      const actualSha256 = createHash('sha256').update(bytes).digest('hex');
      if (actualSha256 !== input.sha256) {
        failures.push({ path: input.path, reason: 'stale', expectedSha256: input.sha256, actualSha256 });
      }
    }

    if (failures.length) {
      console.error(JSON.stringify({ ok: false, packId: contract.packId, failures }, null, 2));
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify({ ok: true, packId: contract.packId, verifiedInputs: contract.requiredInputs.length }));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error?.status === 400 || error instanceof SyntaxError ? 2 : 1;
  }
}

function resolveInside(root, candidate) {
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${candidate}`);
  }
  return resolved;
}
