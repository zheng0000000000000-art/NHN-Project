#!/usr/bin/env node
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { runBalanceOperation } from '../../src/balance-service.js';

const args = process.argv.slice(2);
const modeFlag = args.find((arg) => arg.startsWith('--mode='));
const modeOverride = modeFlag ? modeFlag.slice('--mode='.length) : '';
const positional = args.filter((arg) => !arg.startsWith('--'));
const inputPath = path.resolve(positional[0] || '');
if (!positional[0]) {
  console.error('Usage: node tools/verification/check-balance-gate.mjs <balance-request.json> [--mode=tune|evaluate]');
  process.exit(2);
}
if (modeOverride && modeOverride !== 'tune' && modeOverride !== 'evaluate') {
  console.error(`balance-gate error: unknown mode "${modeOverride}"`);
  process.exit(2);
}

try {
  const parsed = JSON.parse(await readFile(inputPath, 'utf8'));
  const request = modeOverride ? { ...parsed, mode: modeOverride } : parsed;
  const result = runBalanceOperation(request);
  const evaluated = request.mode === 'evaluate' ? result : result.candidate;
  const score = evaluated?.score || {};
  const outputs = evaluated?.outputs || {};
  const failedMetrics = (request.spec?.metrics || []).flatMap((metric) => {
    const metricId = metric.metricId || metric.id || metric.name;
    const value = Number(outputs[metricId]);
    const failures = [];
    if (!Number.isFinite(value)) failures.push('not-finite');
    if (metric.minimum != null && value < Number(metric.minimum)) failures.push(`below ${metric.minimum}`);
    if (metric.maximum != null && value > Number(metric.maximum)) failures.push(`above ${metric.maximum}`);
    return failures.length ? [{ metricId, value, failures }] : [];
  });
  const passed = Number(score.violations || 0) === 0 && failedMetrics.length === 0;
  process.stdout.write(`${JSON.stringify({
    passed,
    mode: result.mode,
    balanceId: result.balanceId || result.spec?.balanceId,
    violations: Number(score.violations || 0),
    score: Number(score.total || 0),
    failedMetrics,
  })}\n`);
  process.exitCode = passed ? 0 : 1;
} catch (error) {
  console.error(`balance-gate error: ${error.message}`);
  process.exitCode = 2;
}
