import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { atomicWriteJson, atomicWriteText, HttpError, nowIso, readJson } from './utils.js';

const EMPTY_INDEX = { schemaVersion: 1, entries: [] };

export class BalancePortfolioStore {
  constructor(dataDirectory) {
    this.root = path.join(dataDirectory, 'balance-portfolio');
    this.indexPath = path.join(this.root, 'index.json');
    this.lock = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.root, { recursive: true });
    const index = await readJson(this.indexPath, EMPTY_INDEX);
    if (!Array.isArray(index.entries)) throw new Error('Invalid balance portfolio index.');
    await atomicWriteJson(this.indexPath, index);
  }

  async capture(experiment, { decisionReason = '' } = {}) {
    return this.#withLock(async () => {
      const entry = buildEntry(experiment, decisionReason);
      const directory = path.join(this.root, safeId(experiment.id));
      await mkdir(directory, { recursive: true });
      await Promise.all([
        atomicWriteText(path.join(directory, 'decision.md'), renderDecision(entry)),
        atomicWriteJson(path.join(directory, 'patch.json'), entry.patch),
        atomicWriteJson(path.join(directory, 'metrics.json'), entry.metrics),
        atomicWriteText(path.join(directory, 'chart.svg'), renderChart(entry.metrics)),
      ]);
      const index = await readJson(this.indexPath, EMPTY_INDEX);
      const previous = index.entries.findIndex((item) => item.experimentId === entry.experimentId);
      const summary = {
        experimentId: entry.experimentId,
        title: entry.title,
        status: entry.status,
        provider: entry.provider,
        solved: entry.solved,
        createdAt: entry.createdAt,
        updatedAt: nowIso(),
        artifactPath: `balance-portfolio/${entry.experimentId}`,
      };
      if (previous >= 0) index.entries[previous] = summary;
      else index.entries.unshift(summary);
      await atomicWriteJson(this.indexPath, index);
      return summary;
    });
  }

  async list({ limit = 100 } = {}) {
    const index = await readJson(this.indexPath, EMPTY_INDEX);
    return index.entries.slice(0, Math.max(1, Math.min(1_000, Number(limit) || 100)));
  }

  async read(experimentId) {
    const id = safeId(experimentId);
    const directory = path.join(this.root, id);
    try {
      const [decision, patch, metrics, chart] = await Promise.all([
        readFile(path.join(directory, 'decision.md'), 'utf8'),
        readJson(path.join(directory, 'patch.json'), null),
        readJson(path.join(directory, 'metrics.json'), null),
        readFile(path.join(directory, 'chart.svg'), 'utf8'),
      ]);
      return { experimentId: id, decision, patch, metrics, chart };
    } catch (error) {
      if (error?.code === 'ENOENT') throw new HttpError(404, 'Balance portfolio entry not found.');
      throw error;
    }
  }

  #withLock(work) {
    const result = this.lock.then(work, work);
    this.lock = result.catch(() => {});
    return result;
  }
}

function buildEntry(experiment, decisionReason) {
  const result = experiment.result || {};
  const baselineOutputs = result.baseline?.outputs || result.outputs || {};
  const candidateOutputs = result.candidate?.outputs || {};
  return {
    experimentId: experiment.id,
    title: experiment.title,
    provider: experiment.provider,
    status: experiment.status,
    createdAt: experiment.createdAt,
    appliedAt: experiment.appliedAt,
    solved: Boolean(result.solved),
    objective: experiment.request?.spec?.objective || experiment.request?.spec?.balanceId || experiment.title,
    decisionReason: decisionReason || automaticDecisionReason(experiment),
    patch: buildPatch(experiment),
    metrics: Object.fromEntries((experiment.request?.spec?.metrics || []).map((metric) => [
      metric.metricId,
      {
        baseline: baselineOutputs[metric.metricId] ?? null,
        candidate: candidateOutputs[metric.metricId] ?? null,
        minimum: metric.minimum ?? null,
        maximum: metric.maximum ?? null,
        weight: metric.weight ?? 1,
      },
    ])),
    observationCount: result.observationSet?.observations?.length || 0,
    paretoCount: result.paretoCandidates?.length || 0,
  };
}

function buildPatch(experiment) {
  const request = experiment.request || {};
  const candidate = experiment.result?.candidate || {};
  return {
    experimentId: experiment.id,
    status: experiment.status,
    parameters: (request.spec?.parameterSpace || []).map((definition) => ({
      parameterId: definition.parameterId,
      path: definition.path,
      before: getAtPath(request.baseline, definition.path),
      after: getAtPath(candidate.data, definition.path),
    })).filter((item) => item.before !== item.after),
  };
}

function renderDecision(entry) {
  const metricRows = Object.entries(entry.metrics).map(([id, metric]) =>
    `| ${id} | ${format(metric.baseline)} | ${format(metric.candidate)} | ${format(metric.minimum)} ~ ${format(metric.maximum)} |`).join('\n');
  const patchRows = entry.patch.parameters.length
    ? entry.patch.parameters.map((item) => `- \`${item.parameterId}\`: ${format(item.before)} → ${format(item.after)} (\`${item.path}\`)`).join('\n')
    : '- 수치 패치 없음';
  return `# ${entry.title}

- Experiment: \`${entry.experimentId}\`
- Provider: \`${entry.provider}\`
- Status: \`${entry.status}\`
- Created: ${entry.createdAt}
- Applied: ${entry.appliedAt || '아직 적용되지 않음'}
- Solved: ${entry.solved ? 'YES' : 'NO'}

## 문제와 목표

${entry.objective}

## 자동 결정 기록

${entry.decisionReason}

## 선택된 패치

${patchRows}

## 핵심 지표

| 지표 | 기준 | 후보 | 목표 범위 |
| --- | ---: | ---: | ---: |
${metricRows || '| 기록 없음 | — | — | — |'}

## 실험 범위

- 평가 후보: ${entry.observationCount}
- 파레토 후보: ${entry.paretoCount}

이 문서는 실험 완료와 상태 변경 시 Team Loop가 자동으로 갱신했다.
`;
}

function renderChart(metrics) {
  const rows = Object.entries(metrics);
  const width = 900;
  const rowHeight = 54;
  const height = Math.max(120, 50 + rows.length * rowHeight);
  const body = rows.map(([id, metric], index) => {
    const values = [metric.baseline, metric.candidate, metric.minimum, metric.maximum].map(Number).filter(Number.isFinite);
    const maximum = Math.max(1, ...values.map(Math.abs));
    const baselineWidth = Math.max(0, Number(metric.baseline) / maximum * 280);
    const candidateWidth = Math.max(0, Number(metric.candidate) / maximum * 280);
    const y = 35 + index * rowHeight;
    return `<text x="10" y="${y}" font-size="12">${escapeXml(id)}</text>
<rect x="290" y="${y - 14}" width="${baselineWidth}" height="12" fill="#7c8aa5"/>
<rect x="290" y="${y + 2}" width="${candidateWidth}" height="12" fill="#43b581"/>
<text x="580" y="${y - 3}" font-size="11">기준 ${escapeXml(format(metric.baseline))}</text>
<text x="580" y="${y + 13}" font-size="11">후보 ${escapeXml(format(metric.candidate))}</text>`;
  }).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="#ffffff"/>
<style>text{font-family:system-ui,sans-serif;fill:#1c2430}</style>
${body}
</svg>`;
}

function automaticDecisionReason(experiment) {
  if (experiment.status === 'APPLIED') return '모든 승인 절차를 거쳐 후보 패치를 기준 데이터에 적용했다.';
  if (experiment.result?.solved) return '후보가 현재 실험 계약의 모든 목표 범위를 충족해 적용 대기 상태로 기록했다.';
  return '모든 목표를 동시에 충족하지 못했으며 가장 위반이 적은 후보를 후속 실험 기준으로 보존했다.';
}

function getAtPath(target, slashPath) {
  return String(slashPath || '').split('/').filter(Boolean).reduce((value, key) => value?.[key], target);
}

function format(value) {
  return value === null || value === undefined ? '—' : Number.isFinite(Number(value)) ? Number(value).toFixed(3).replace(/\.?0+$/, '') : String(value);
}

function safeId(value) {
  const id = String(value || '');
  if (!/^bal_[a-zA-Z0-9_-]+$/.test(id)) throw new HttpError(400, 'Invalid balance experiment id.');
  return id;
}

function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
