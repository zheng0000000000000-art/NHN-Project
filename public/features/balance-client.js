export async function startBalanceJob(api, request) {
  const payload = await api('/api/balance/jobs', { method: 'POST', body: request });
  return payload.job;
}

export async function waitForBalanceJob(api, jobId, { onProgress = null, pollIntervalMs = 250 } = {}) {
  while (true) {
    const payload = await api(`/api/balance/jobs/${encodeURIComponent(jobId)}`);
    const job = payload.job;
    onProgress?.(job);
    if (job.status === 'COMPLETED') return job;
    if (job.status === 'FAILED') throw new Error(job.error?.message || 'Balance job failed.');
    if (job.status === 'CANCELLED') throw new Error('Balance job was cancelled.');
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

export async function readBalanceExperiment(api, experimentId, view = 'raw') {
  const payload = await api(`/api/balance/experiments/${encodeURIComponent(experimentId)}?view=${encodeURIComponent(view)}`);
  return payload.experiment;
}
