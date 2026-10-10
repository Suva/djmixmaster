// Runs one analysis or render job off the main thread so the window stays responsive.
import { parentPort, workerData } from 'node:worker_threads';
import { measure, render } from '../master.ts';
import type { Job, JobMessage } from './api.ts';

const port = parentPort!;
const send = (message: JobMessage) => port.postMessage(message);

let reported = -1;
const progress = (fraction: number) => {
  const step = Math.floor(fraction * 200);
  if (step === reported) return;
  reported = step;
  send({ type: 'progress', fraction });
};

async function run(job: Job): Promise<unknown> {
  if (job.kind === 'measure') return measure(job.input, {}, progress);
  const region = { start: job.start, end: job.end };
  return render(job.input, region, job.gainDb, job.output, { ceilingDb: job.ceilingDb }, progress);
}

run(workerData as Job).then(
  (result) => send({ type: 'done', result }),
  (error) => send({ type: 'error', message: error instanceof Error ? error.message : String(error) }),
);
