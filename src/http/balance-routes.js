import { runBalanceOperation } from '../balance-service.js';
import { projectBalanceExperiment, projectBalanceResult } from '../balance-result-view.js';
import { HttpError } from '../utils.js';

export async function handleBalanceRoute({
  method, url, request, response, actor, readBody, sendJson, assertPlainObject,
  balanceExperiments, balanceJobs, balanceSeeds, audit,
}) {
  if (!url.pathname.startsWith('/api/balance/')) return false;

  if (method === 'POST' && url.pathname === '/api/balance/run') {
    const body = await readBody(request);
    assertPlainObject(body);
    const responseDetail = ['full', 'raw'].includes(body.responseDetail) ? 'full' : 'summary';
    const operation = { ...body };
    delete operation.responseDetail;
    const balance = runBalanceOperation(operation);
    const experiment = await balanceExperiments.record(actor, operation, balance);
    sendJson(response, 200, {
      balance: projectBalanceResult(balance, responseDetail),
      experiment: projectBalanceExperiment(experiment, { view: responseDetail }),
    });
    return true;
  }

  if (method === 'POST' && url.pathname === '/api/balance/jobs') {
    const body = await readBody(request);
    assertPlainObject(body);
    const operation = { ...body };
    delete operation.responseDetail;
    sendJson(response, 202, { job: await balanceJobs.start({ actor, request: operation }) });
    return true;
  }

  const jobMatch = url.pathname.match(/^\/api\/balance\/jobs\/([^/]+)(?:\/(cancel|resume))?$/);
  if (jobMatch) {
    const jobId = decodeURIComponent(jobMatch[1]);
    if (method === 'GET' && !jobMatch[2]) {
      sendJson(response, 200, { job: balanceJobs.get(jobId, actor) });
      return true;
    }
    if (method === 'POST' && jobMatch[2] === 'cancel') {
      sendJson(response, 200, { job: await balanceJobs.cancel(jobId, actor) });
      return true;
    }
    if (method === 'POST' && jobMatch[2] === 'resume') {
      sendJson(response, 200, { job: await balanceJobs.resume(jobId, actor) });
      return true;
    }
  }

  if (method === 'GET' && url.pathname === '/api/balance/seeds') {
    sendJson(response, 200, { seeds: balanceSeeds.list() });
    return true;
  }

  const seedMatch = url.pathname.match(/^\/api\/balance\/seeds\/([^/]+)$/);
  if (method === 'GET' && seedMatch) {
    const seed = balanceSeeds.get(decodeURIComponent(seedMatch[1]));
    if (!seed) throw new HttpError(404, 'Balance seed not found.');
    sendJson(response, 200, { seed });
    return true;
  }

  if (method === 'GET' && url.pathname === '/api/balance/experiments') {
    const view = ['full', 'raw'].includes(url.searchParams.get('view')) ? 'full' : 'summary';
    const experiments = await balanceExperiments.list({
      limit: url.searchParams.get('limit'),
      actorUserId: actor.id,
      detail: view === 'full' ? 'full' : 'summary',
    });
    sendJson(response, 200, {
      experiments: view === 'full'
        ? experiments.map((item) => projectBalanceExperiment(item, { view }))
        : experiments,
    });
    return true;
  }

  const resultMatch = url.pathname.match(/^\/api\/balance\/experiments\/([^/]+)$/);
  if (method === 'GET' && resultMatch) {
    const experiment = await balanceExperiments.get(decodeURIComponent(resultMatch[1]), {
      actorUserId: actor.id,
      actorRole: actor.role,
    });
    const view = ['diagnostics', 'full', 'raw'].includes(url.searchParams.get('view'))
      ? url.searchParams.get('view')
      : 'summary';
    sendJson(response, 200, {
      experiment: projectBalanceExperiment(experiment, {
        view,
        metricId: url.searchParams.get('metricId') || '',
        policyId: url.searchParams.get('policyId') || '',
      }),
    });
    return true;
  }

  const applyMatch = url.pathname.match(/^\/api\/balance\/experiments\/([^/]+)\/apply$/);
  if (method === 'POST' && applyMatch) {
    const experiment = await balanceExperiments.apply(applyMatch[1], actor);
    await audit(actor.id, 'BALANCE_CANDIDATE_APPLIED', {
      experimentId: experiment.id,
      balanceId: experiment.result?.balanceId || experiment.request?.spec?.balanceId,
    });
    sendJson(response, 200, { experiment });
    return true;
  }

  throw new HttpError(404, 'Balance API route not found.');
}
