import fs from 'node:fs/promises';
import path from 'node:path';
import { chartLayoutForCycleDirectory } from './chart-paths.ts';
import { acquireChartBuildLock } from './chart-build-lock.ts';
import { moveVerifiedFile } from './fs-utils.ts';

/** Move older extracted rasters out of the publishable chart tree. */
export async function migrateChartSources(chartRoot: string): Promise<void> {
    for (const cycle of await fs.readdir(chartRoot, { withFileTypes: true })) {
        if (!cycle.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(cycle.name)) continue;
        const { legacyDirectory: directory, sourceDirectory } = chartLayoutForCycleDirectory(path.join(chartRoot, cycle.name));
        if (sourceDirectory === directory) continue;
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            if (!entry.isFile() || !/\.tif$/i.test(entry.name)) continue;
            const source = path.join(directory, entry.name);
            const destination = path.join(sourceDirectory, entry.name);
            const release = await acquireChartBuildLock(source.replace(/\.tif$/i, ''));
            try {
                await fs.mkdir(sourceDirectory, { recursive: true });
                await moveVerifiedFile(source, destination, 'chart source');
            } finally {
                await release();
            }
        }
    }
}
