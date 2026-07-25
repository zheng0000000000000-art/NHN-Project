import { runBalanceOperation } from '../balance-service.js';
import { projectBalanceExperiment, projectBalanceResult } from '../balance-result-view.js';
import { HttpError } from '../utils.js';

export async function handleBalanceRoute({
  method, url, request, response, actor, readBody, sendJson, assertPlainObject,
  balanceExperiments, balancePortfolio, balanceJobs, balanceSeeds, auctionPlaySessions, audit,
}) {
  if (!url.pathname.startsWith('/api/balance/')) return false;

  if (method === 'GET' && url.pathname === '/api/balance/play/sessions') {
    sendJson(response, 200, { sessions: auctionPlaySessions.list(actor, { limit: url.searchParams.get('limit') }) });
    return true;
  }

  if (method === 'POST' && url.pathname === '/api/balance/play/sessions') {
    const body = await readBody(request);
    assertPlainObject(body);
    const session = await auctionPlaySessions.start(actor, body);
    await audit(actor.id, 'AUCTION_PLAY_STARTED', { sessionId: session.id, seed: session.seed });
    sendJson(response, 201, { session });
    return true;
  }

  const informationValueMatch = url.pathname.match(/^\/api\/balance\/play\/sessions\/([^/]+)\/information-value$/);
  if (method === 'GET' && informationValueMatch) {
    const sessionId = decodeURIComponent(informationValueMatch[1]);
    sendJson(response, 200, { informationValue: auctionPlaySessions.informationValue(sessionId, actor) });
    return true;
  }

  const playMatch = url.pathname.match(/^\/api\/balance\/play\/sessions\/([^/]+)(?:\/actions)?$/);
  if (playMatch) {
    const sessionId = decodeURIComponent(playMatch[1]);
    if (method === 'GET') {
      sendJson(response, 200, { session: auctionPlaySessions.get(sessionId, actor) });
      return true;
    }
    if (method === 'POST' && url.pathname.endsWith('/actions')) {
      const body = await readBody(request);
      assertPlainObject(body);
      const session = await auctionPlaySessions.act(sessionId, actor, body);
      sendJson(response, 200, { session });
      return true;
    }
  }

  if (method === 'POST' && url.pathname === '/api/balance/run') {
    const body = await readBody(request);
    assertPlainObject(body);
    const responseDetail = ['full', 'raw'].includes(body.responseDetail) ? 'full' : 'summary';
    const operation = { ...body };
    delete operation.responseDetail;
    const balance = runBalanceOperation(operation);
    const experiment = await balanceExperiments.record(actor, operation, balance);
    await balancePortfolio.capture(experiment);
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

  if (method === 'GET' && url.pathname === '/api/balance/portfolio') {
    sendJson(response, 200, { entries: await balancePortfolio.list({ limit: url.searchParams.get('limit') }) });
    return true;
  }

  const portfolioMatch = url.pathname.match(/^\/api\/balance\/portfolio\/([^/]+)$/);
  if (method === 'GET' && portfolioMatch) {
    const experiment = await balanceExperiments.get(decodeURIComponent(portfolioMatch[1]), {
      actorUserId: actor.id,
      actorRole: actor.role,
    });
    sendJson(response, 200, {
      entry: await balancePortfolio.read(experiment.id),
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
    await balancePortfolio.capture(experiment, { decisionReason: '사용자가 후보 패치를 승인하여 기준 데이터에 적용했다.' });
    await audit(actor.id, 'BALANCE_CANDIDATE_APPLIED', {
      experimentId: experiment.id,
      balanceId: experiment.result?.balanceId || experiment.request?.spec?.balanceId,
    });
    sendJson(response, 200, { experiment });
    return true;
  }

  throw new HttpError(404, 'Balance API route not found.');
}
