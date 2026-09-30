import fs from 'node:fs/promises';
import path from 'node:path';
import { moveVerifiedFile } from './fs-utils.ts';

export function navSourceDirectory(outputRoot: string, cycle: string): string {
    return path.resolve(outputRoot, 'sources', cycle, 'nav');
}

/** Consolidate old NASR and CIFP inputs in one local navigation source cache. */
export async function migrateNavSources(outputRoot: string): Promise<void> {
    const chartRoot = path.resolve(outputRoot, 'charts');
    let cycles;
    try { cycles = await fs.readdir(chartRoot, { withFileTypes: true }); }
    catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
    for (const cycle of cycles) {
        if (!cycle.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(cycle.name)) continue;
        const oldDirectory = path.join(chartRoot, cycle.name, 'nasr');
        let files;
        try { files = await fs.readdir(oldDirectory, { withFileTypes: true }); }
        catch (error: any) { if (error.code === 'ENOENT') continue; throw error; }
        const destinationDirectory = navSourceDirectory(outputRoot, cycle.name);
        await fs.mkdir(destinationDirectory, { recursive: true });
        for (const entry of files) {
            if (!entry.isFile()) throw new Error(`Unexpected navigation source: ${entry.name}`);
            const source = path.join(oldDirectory, entry.name);
            const destination = path.join(destinationDirectory, entry.name);
            await moveVerifiedFile(source, destination, 'navigation source');
        }
        await fs.rmdir(oldDirectory);
    }
}
