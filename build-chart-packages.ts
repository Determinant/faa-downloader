#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageChartCycle, validateRegions, type OfflineRegionDefinition } from './lib/chart-packager.ts';
import { chartCacheDirectory } from './lib/chart-paths.ts';

export async function buildChartPackages(output = 'dist', regionsFile?: string, force = false): Promise<void> {
    const regions = await readOfflineRegions(regionsFile);
    const root = path.resolve(output, 'charts');
    let cycles = 0;
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
        const directory = chartCacheDirectory(path.join(root, entry.name));
        try { await fs.access(path.join(directory, 'chart-manifest.json')); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        console.log(`Checking chart packages for ${entry.name}`);
        const manifest = await packageChartCycle(directory, path.join(root, entry.name, 'mbtiles'), { regions, force });
        cycles += 1;
        console.log(`Ready: ${manifest.archives.length} small archives and ${manifest.regions.length} offline regions`);
    }
    if (cycles === 0) throw new Error(`No verified sheet manifests under ${root}; finish sheet tiling and build:chart-manifests first`);
}

export async function readOfflineRegions(file?: string): Promise<OfflineRegionDefinition[] | undefined> {
    if (file === undefined) return undefined;
    const regions = JSON.parse(await fs.readFile(file, 'utf8'));
    validateRegions(regions);
    return regions;
}

async function main(): Promise<void> {
    let output = 'dist';
    let regions: string | undefined;
    let force = false;
    for (const arg of process.argv.slice(2)) {
        if (arg.startsWith('--output=')) output = arg.slice(9);
        else if (arg.startsWith('--regions=')) regions = arg.slice(10);
        else if (arg === '--force') force = true;
        else if (arg === '--help' || arg === '-h') {
            console.log('Usage: npm run build:chart-packages -- [--output=dist] [--regions=regions.json] [--force]\n' +
                'Stitch verified sheet archives into size-bounded spatial/zoom MBTiles and offline region indexes.\n' +
                'Unchanged, verified packages are reused; --force recomposes them.\n' +
                'Region JSON: [{"id":"region","title":"Region","bounds":[[west,south,east,north]]}].');
            return;
        } else throw new Error(`Unknown argument: ${arg}`);
    }
    if (!output.trim() || (regions !== undefined && !regions.trim())) throw new Error('Paths must not be empty');
    await buildChartPackages(output, regions, force);
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(process.argv[1]).href : '')) {
    main().catch(error => { console.error(error); process.exitCode = 1; });
}
