import { Worker } from 'node:worker_threads';
import type { StoredBlock } from './glide-delivery.ts';
import type { Mask } from './glide-package-overview.ts';
import type { PackageJob } from './glide-package-worker.ts';
export type PackageResult = { detail: StoredBlock[]; masks: Mask[]; records: number; digest: string };

export async function packageSourceJobs(jobs: PackageJob[], concurrency: number,
    progress: (completed: number, result: PackageResult) => void): Promise<PackageResult[]> {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Packaging concurrency must be 1..8');
    const workers: Worker[] = [], results: PackageResult[] = new Array(jobs.length);
    let cursor = 0, completed = 0, failed = false;
    try {
        await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
            const worker = new Worker(new URL('./glide-package-worker.ts', import.meta.url), { execArgv: [] });
            workers.push(worker);
            while (!failed && cursor < jobs.length) {
                const index = cursor++;
                const result = await new Promise<PackageResult>((resolve, reject) => {
                    const done = () => { worker.off('message', message); worker.off('error', error); worker.off('exit', exit); };
                    const message = (value: PackageResult & { error?: string }) => { done(); value.error ? reject(new Error(value.error)) : resolve(value); };
                    const error = (value: Error) => { done(); reject(value); };
                    const exit = (code: number) => { done(); reject(new Error(`Glide packaging worker exited ${code}`)); };
                    worker.once('message', message); worker.once('error', error); worker.once('exit', exit); worker.postMessage(jobs[index]);
                }).catch(error => { failed = true; throw error; });
                results[index] = result; progress(++completed, result);
            }
        }));
        return results;
    } finally { failed = true; await Promise.all(workers.map(worker => worker.terminate())); }
}
