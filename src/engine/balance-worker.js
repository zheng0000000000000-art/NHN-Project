import { parentPort } from 'node:worker_threads';
import { runBalanceOperation } from '../balance-service.js';

parentPort.on('message', ({ request }) => {
  try {
    const result = runBalanceOperation(request, {
      onProgress(progress) {
        parentPort.postMessage({ type: 'progress', progress });
      },
    });
    parentPort.postMessage({ type: 'complete', result });
  } catch (error) {
    parentPort.postMessage({
      type: 'failed',
      error: {
        name: error?.name || 'Error',
        message: error?.message || String(error),
        status: Number(error?.status) || 500,
      },
    });
  }
});
