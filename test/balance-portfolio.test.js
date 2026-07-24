import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BalancePortfolioStore } from '../src/balance-portfolio.js';

const experiment = {
  id: 'bal_portfolio',
  title: 'Bot participation tuning',
  provider: 'auction-economy-v1',
  status: 'PROPOSED',
  createdAt: '2026-07-25T00:00:00.000Z',
  appliedAt: null,
  request: {
    spec: {
      balanceId: 'auction',
      objective: 'Keep blind ROI and no-contest rates inside target bands.',
      parameterSpace: [{ parameterId: 'bid', path: 'bots/bid', minimum: 0.7, maximum: 0.9, step: 0.1 }],
      metrics: [{ metricId: 'roi', minimum: 0, maximum: 14, weight: 2 }],
    },
    baseline: { bots: { bid: 0.7 } },
  },
  result: {
    solved: true,
    baseline: { outputs: { roi: 20 }, score: { violations: 1 } },
    candidate: { data: { bots: { bid: 0.9 } }, outputs: { roi: 13 }, score: { violations: 0 } },
    observationSet: { observations: [{}, {}] },
    paretoCandidates: [{}],
  },
};

test('balance experiments automatically become portfolio-ready artifact bundles', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'balance-portfolio-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new BalancePortfolioStore(directory);
  await store.initialize();
  await store.capture(experiment);
  const entries = await store.list();
  assert.equal(entries[0].experimentId, experiment.id);
  const bundle = await store.read(experiment.id);
  assert.match(bundle.decision, /Bot participation tuning/);
  assert.match(bundle.decision, /0.7 → 0.9/);
  assert.equal(bundle.patch.parameters[0].after, 0.9);
  assert.equal(bundle.metrics.roi.candidate, 13);
  assert.match(bundle.chart, /^<svg/);
  const markdown = await readFile(path.join(directory, 'balance-portfolio', experiment.id, 'decision.md'), 'utf8');
  assert.match(markdown, /자동으로 갱신/);
});
