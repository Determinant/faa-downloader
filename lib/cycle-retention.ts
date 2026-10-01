import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_RETAIN_CYCLES = 2;
export type CycleProduct = 'nav' | 'mbtiles' | 'tpp' | 'cs';
export type CycleWindow = { through: string; oldest?: string };

export function parseRetainCycles(value: string): number {
    const count = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(count) || count < 1) {
        throw new Error('--retain-cycles must be a positive integer');
    }
    return count;
}

export function isCycle(value: string): boolean {
    const date = new Date(`${value}T00:00:00Z`);
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.getTime()) &&
        date.toISOString().slice(0, 10) === value;
}

export function includesCycle(window: CycleWindow, cycle: string): boolean {
    return cycle <= window.through && (!window.oldest || cycle >= window.oldest);
}

/** Pending editions can bound work, but only published editions authorize deletion. */
export async function productCycleWindow(output: string, product: CycleProduct, retain: number,
    through: string, pending: Iterable<string> = []): Promise<CycleWindow> {
    parseRetainCycles(String(retain));
    if (!isCycle(through)) throw new Error(`Invalid retention cutoff: ${through}`);
    const root = path.join(output, 'charts');
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
    });
    const completed = new Set([...pending].filter(cycle => isCycle(cycle) && cycle <= through));
    for (const entry of entries) {
        if (!entry.isDirectory() || !isCycle(entry.name) || entry.name > through) continue;
        const pointer = path.join(root, entry.name, product, product === 'cs' ? 'catalog.json' : 'manifest.json');
        const published = await fs.lstat(pointer).catch(error => {
            if (error.code === 'ENOENT') return undefined;
            throw error;
        });
        if (published?.isFile()) completed.add(entry.name);
    }
    return { through, oldest: [...completed].sort().reverse()[retain - 1] };
}
