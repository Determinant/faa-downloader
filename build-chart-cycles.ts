#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileAtomic } from './lib/fs-utils.ts';
import { isRecord, readJson } from './lib/build-cache.ts';
import { isCycle } from './lib/cycle-retention.ts';
import { isDeepStrictEqual } from 'node:util';

type ChartCycleIndex = { schemaVersion: number; generatedAt: string; cycles: string[]; rasterCycles: string[] };

const rasterManifests = ['mbtiles/manifest.json', 'mbtiles/packages/manifest.json',
    'mbtiles/chart-manifest.json', 'chart-manifest.json'];

export async function buildChartCycles(output = 'dist'): Promise<ChartCycleIndex> {
    const root = path.resolve(output, 'charts');
    const entries = await fs.readdir(root, { withFileTypes: true });
    const cycles = entries.filter(entry => entry.isDirectory() && isCycle(entry.name))
        .map(entry => entry.name).sort().reverse();
    const rasterCycles: string[] = [];
    for (const cycle of cycles) {
        for (const manifest of rasterManifests) {
            const file = await fs.lstat(path.join(root, cycle, manifest)).catch(error => {
                if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
                throw error;
            });
            if (file?.isFile()) { rasterCycles.push(cycle); break; }
        }
    }
    const previous = await readJson(path.join(root, 'cycles.json'));
    if (isRecord(previous) && previous.schemaVersion === 1 && typeof previous.generatedAt === 'string' &&
        Number.isFinite(Date.parse(previous.generatedAt)) && isDeepStrictEqual(previous.cycles, cycles) &&
        isDeepStrictEqual(previous.rasterCycles, rasterCycles)) {
        return previous as ChartCycleIndex;
    }
    const index = { schemaVersion: 1, generatedAt: new Date().toISOString(), cycles, rasterCycles };
    await writeFileAtomic(path.join(root, 'cycles.json'), `${JSON.stringify(index, null, 2)}\n`);
    return index;
}

async function main(): Promise<void> {
    let output = 'dist';
    let help = false;
    for (const argument of process.argv.slice(2)) {
        if (argument.startsWith('--output=')) output = argument.slice('--output='.length);
        else if (argument === '--help' || argument === '-h') help = true;
        else throw new Error(`Unknown argument: ${argument}`);
    }
    if (help) {
        console.log(`Usage: npm run build:chart-cycles -- [--output=DIR]

Write DIR/charts/cycles.json with dated directories and raster availability (default: dist).
No downloads or tile rendering are performed. Publish dated files before this index.`);
        return;
    }
    if (!output.trim()) throw new Error('--output must not be empty');
    const index = await buildChartCycles(output);
    console.log(`Published cycle index: ${index.cycles.join(', ')}`);
}

const entryPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entryPath) {
    main().catch(error => {
        console.error('❌ Error:', error);
        process.exitCode = 1;
    });
}
