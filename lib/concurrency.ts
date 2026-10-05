export const DEFAULT_DOWNLOAD_CONCURRENCY = 4;
export const DEFAULT_TILE_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 16;

export function parseConcurrency(
    raw: string | number,
    label = 'concurrency'
): number {
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > MAX_CONCURRENCY) {
        throw new Error(`${label} must be an integer from 1 to ${MAX_CONCURRENCY}`);
    }
    return value;
}

export async function mapWithConcurrency<T, R>(
    items: readonly T[],
    concurrency: number,
    operation: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new Error('concurrency must be a positive integer');
    }
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    let failed = false;
    let failure: unknown;
    const workers = Array.from(
        { length: Math.min(concurrency, items.length) },
        async () => {
            while (!failed && nextIndex < items.length) {
                const index = nextIndex;
                nextIndex += 1;
                try {
                    results[index] = await operation(items[index], index);
                } catch (error) {
                    failed = true;
                    failure = error;
                }
            }
        }
    );
    await Promise.all(workers);
    if (failed) throw failure;
    return results;
}

/** Bounded, completion-ordered preparation feeds independent consumers; results retain input order. */
export async function mapWithPrefetch<T, P, R>(items: readonly T[], concurrency: number,
    prepare: (item: T, index: number) => Promise<P>, consume: (prepared: P, index: number) => Promise<R>): Promise<R[]> {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be a positive integer');
    const preparing = new Set<Promise<void>>(), consuming = new Set<Promise<void>>();
    const ready: { value: P; index: number }[] = [], results = new Array<R>(items.length);
    let next = 0, failed = false, failure: unknown;
    const launch = (jobs: Set<Promise<void>>, task: () => Promise<void>) => {
        const job = Promise.resolve().then(task).catch(error => {
            if (!failed) { failed = true; failure = error; }
        }).finally(() => jobs.delete(job));
        jobs.add(job);
    };
    for (;;) {
        if (!failed) {
            while (ready.length && consuming.size < concurrency) {
                const { value, index } = ready.shift()!;
                launch(consuming, async () => { results[index] = await consume(value, index); });
            }
            // At most one extra region per consumer is downloading or ready.
            while (next < items.length && preparing.size + ready.length < concurrency) {
                const index = next++;
                launch(preparing, async () => { ready.push({ value: await prepare(items[index], index), index }); });
            }
        }
        if (!preparing.size && !consuming.size && (failed || !ready.length && next === items.length)) break;
        // Drain every accepted operation on failure before the caller closes shared resources.
        await Promise.race([...preparing, ...consuming]);
    }
    if (failed) throw failure;
    return results;
}
