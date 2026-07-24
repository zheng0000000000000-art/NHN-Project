import path from 'node:path';
import { readJson } from './utils.js';

const EMPTY_MANIFEST = { schemaVersion: 1, seeds: [] };

export class BalanceSeedRegistry {
  constructor({ projectRoot, manifestPath }) {
    this.projectRoot = projectRoot;
    this.manifestPath = manifestPath;
    this.seeds = [];
  }

  async initialize() {
    const manifest = await readJson(this.manifestPath, EMPTY_MANIFEST);
    if (!Array.isArray(manifest.seeds)) throw new Error('Invalid balance seed manifest.');
    this.seeds = [];
    for (const item of manifest.seeds) {
      const id = String(item.id || '').trim();
      const source = String(item.source || '').replaceAll('\\', '/');
      if (!id || !source || source.startsWith('/') || source.includes('..')) throw new Error('Balance seeds need a safe id and project-relative source.');
      const request = await readJson(path.join(this.projectRoot, source), null);
      if (!request?.spec || !request?.baseline) throw new Error(`Balance seed ${id} needs spec and baseline contracts.`);
      this.seeds.push({
        id,
        label: String(item.label || id),
        description: String(item.description || ''),
        provider: String(item.provider || request.provider || ''),
        source,
        request,
      });
    }
  }

  list() {
    return this.seeds.map(({ request, ...seed }) => ({
      ...seed,
      balanceId: request.spec.balanceId,
      parameterCount: request.spec.parameterSpace?.length || 0,
      metricCount: request.spec.metrics?.length || 0,
    }));
  }

  get(id) {
    const seed = this.seeds.find((item) => item.id === id);
    return seed ? structuredClone(seed) : null;
  }
}
