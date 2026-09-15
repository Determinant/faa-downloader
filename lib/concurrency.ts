export const DEFAULT_DOWNLOAD_CONCURRENCY = 4;
export const MAX_DOWNLOAD_CONCURRENCY = 16;

export function parseDownloadConcurrency(
    raw: string | number,
    label = 'concurrency'
): number {
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > MAX_DOWNLOAD_CONCURRENCY) {
        throw new Error(`${label} must be an integer from 1 to ${MAX_DOWNLOAD_CONCURRENCY}`);
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
