#!/usr/bin/env node
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { buildTerrain, terrainBlocks } from './lib/terrain.ts';
import { TERRAIN_RESOLUTION_ARC_SECONDS } from './lib/terrain-grid.ts';

async function main() {
    let output = 'dist', regions: string | URL = new URL('./data/terrain-regions.json', import.meta.url);
    let sourceDirectory: string | undefined, rebuild = false, estimate = false;
    for (const arg of process.argv.slice(2)) {
        if (arg.startsWith('--output=')) output = arg.slice(9);
        else if (arg.startsWith('--regions=')) regions = arg.slice(10);
        else if (arg.startsWith('--source-directory=')) sourceDirectory = arg.slice(19);
        else if (arg === '--rebuild') rebuild = true;
        else if (arg === '--estimate') estimate = true;
        else if (arg === '--help' || arg === '-h') {
            console.log('Usage: npm run build:terrain -- [--output=dist] [--regions=regions.json] [--source-directory=DIR] [--rebuild] [--estimate]\n' +
                `Build independent terrain packages from current USGS 3DEP 1-arc-second GeoTIFFs; ${TERRAIN_RESOLUTION_ARC_SECONDS}-arc-second geographic output with coarser overviews.\n` +
                'Use --estimate before a large build. Regions: [{"id":"name","title":"Name","bounds":[[west,south,east,north]]}].\n' +
                'Every online run checks USGS object versions; unchanged GeoTIFFs are not downloaded again.\n' +
                '--rebuild regenerates packages from verified source cache. Local sources require matching .tif/.xml files.\n' +
                'Publish all charts/terrain data files before manifest.json.');
            return;
        } else throw new Error(`Unknown argument: ${arg}`);
    }
    if (!output.trim() || (typeof regions === 'string' && !regions.trim()) ||
        (sourceDirectory !== undefined && !sourceDirectory.trim())) throw new Error('Paths must not be empty');
    const definitions = JSON.parse(await fs.readFile(regions, 'utf8'));
    if (estimate) {
        const blocks = terrainBlocks(definitions);
        console.log(`${blocks.length.toLocaleString()} archive pairs; ${(blocks.length / 1024).toFixed(1)} GiB of int16 maximum and surface grids before gzip (${TERRAIN_RESOLUTION_ARC_SECONDS} arc-seconds plus overviews).\n` +
            'USGS GeoTIFF download/cache size is additional and depends on coverage. No files downloaded.');
        return;
    }
    const manifest = await buildTerrain(output, definitions, { sourceDirectory, rebuild });
    console.log(`Terrain ready: ${manifest.shards.length} spatial indices.`);
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(process.argv[1]).href : '')) {
    main().catch(error => { console.error(error); process.exitCode = 1; });
}
