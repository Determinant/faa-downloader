#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildGlide } from './lib/glide.ts';
import { glideChunkCount, validateGlideInventory } from './lib/glide-model.ts';
import { defaultGlideAreas, parseGlideBounds } from './lib/glide-defaults.ts';
import { glideConcurrency, glideRegionConcurrency } from './lib/glide-worker.ts';
import { glideAssemblyConcurrency } from './lib/glide-assembly.ts';
import { resumeGlideAssembly } from './lib/glide-assembly-resume.ts';
import { packageGlide } from './lib/glide-packager.ts';
import { checkPackagePaths } from './lib/glide-package-input.ts';

export async function main(args = process.argv.slice(2)): Promise<void> {
    let output = 'dist', sources: string | undefined, rebuild = false, estimate = false, maxBytes: number | undefined;
    let bounds: ReturnType<typeof parseGlideBounds> | undefined, refreshSources = false;
    let concurrency: number | undefined, regionConcurrency: number | undefined, assemblyConcurrency: number | undefined;
    let packagesOutput: string | undefined, skipPackaging = false, assemblyOnly = false;
    for (const arg of args) {
        if (arg.startsWith('--output=')) output = arg.slice(9);
        else if (arg.startsWith('--sources=')) sources = arg.slice(10);
        else if (arg.startsWith('--bbox=')) bounds = parseGlideBounds(arg.slice(7));
        else if (arg.startsWith('--max-bytes=')) maxBytes = Number(arg.slice(12));
        else if (arg.startsWith('--concurrency=')) concurrency = glideConcurrency(Number(arg.slice(14)));
        else if (arg.startsWith('--region-concurrency=')) regionConcurrency = glideRegionConcurrency(Number(arg.slice(21)));
        else if (arg.startsWith('--assembly-concurrency=')) assemblyConcurrency = glideAssemblyConcurrency(Number(arg.slice(23)));
        else if (arg.startsWith('--packages-output=')) packagesOutput = arg.slice(18);
        else if (arg === '--skip-packaging') skipPackaging = true;
        else if (arg === '--assembly-only') assemblyOnly = true;
        else if (arg === '--rebuild') rebuild = true;
        else if (arg === '--refresh-sources') refreshSources = true;
        else if (arg === '--estimate') estimate = true;
        else if (arg === '--help' || arg === '-h') {
            console.log('Usage: npm run build:glide -- [--bbox=west,south,east,north] [--output=dist] [--concurrency=1..16] [--region-concurrency=1..16] [--assembly-concurrency=1..16] [--assembly-only] [--estimate] [--rebuild] [--refresh-sources] [--max-bytes=BYTES] [--packages-output=ROOT] [--skip-packaging]\n' +
                'Prepare experimental connected off-airport candidate areas, independently of terrain and chart builds.\n' +
                'Tiers: preferred ≥2000 × 200 ft; last resort prefers 1500 × 100 ft, retains measured fits down to 600 × 60 ft.\n' +
                'Default: CONUS; automatically download USGS elevation, MRLC cover, native WorldCover, Overture maps and FAA obstacles.\n' +
                '--bbox limits an automatic build. --sources=FILE is an optional custom/local source override.\n' +
                '--refresh-sources refreshes cached cover/map subsets, including corrections to an existing annual release.\n' +
                '--concurrency controls the shared chunk worker pool; default auto-selects up to 16 using available CPU/RAM.\n' +
                '--region-concurrency controls regions in flight, including downloads/preparation; default up to 8.\n' +
                '--assembly-concurrency controls final assembly groups and GDAL workers; default min(4, region concurrency).\n' +
                '--assembly-only resumes saved analysis directly: no source discovery/checks, downloads or screening.\n' +
                'Combine --assembly-only --skip-packaging to run only merge/gzip assembly and publish its manifest.\n' +
                '--max-bytes optionally limits the whole publication; per-shard limits always apply.\n' +
                '--packages-output=ROOT selects the new delivery staging root (default OUTPUT/glide-packages).\n' +
                '--skip-packaging skips the new delivery pass; normal builds still export completed analysis snapshots.\n' +
                'Output: charts/glide/manifest.json and compact gzip area shards; originals stay in glide-cache/.\n' +
                'See docs/glide.md for source requirements, screening limits, and the delivery contract.');
            return;
        } else throw new Error(`Unknown argument: ${arg}`);
    }
    if (assemblyOnly && (rebuild || refreshSources || estimate || concurrency !== undefined || regionConcurrency !== undefined)) {
        throw new Error('--assembly-only cannot be combined with --rebuild, --refresh-sources, --estimate, --concurrency or --region-concurrency');
    }
    if ((sources !== undefined && !sources.trim()) || !output.trim() || (sources && bounds) || packagesOutput !== undefined && !packagesOutput.trim() ||
        (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0))) {
        throw new Error('Use a nonempty output, positive --max-bytes, and either --bbox or --sources when specified');
    }
    if (!skipPackaging) await checkPackagePaths(path.join(output, 'charts/glide/manifest.json'), packagesOutput ?? path.join(output, 'glide-packages'));
    if (estimate) {
        const areas = sources ? validateGlideInventory(JSON.parse(await fs.readFile(sources, 'utf8'))).regions : await defaultGlideAreas(bounds);
        const count = areas.reduce((sum, region) => sum + glideChunkCount(region), 0);
        console.log(`${sources ? 'Custom inputs' : 'Automatic CONUS inputs'}: ${areas.length} regions; ${count} bounded analysis chunks. No files downloaded.\n` +
            `Parallelism: ${glideRegionConcurrency(regionConcurrency, glideConcurrency(concurrency))} regions; ${glideConcurrency(concurrency)} shared chunk workers; ` +
            `${glideAssemblyConcurrency(assemblyConcurrency, glideRegionConcurrency(regionConcurrency, glideConcurrency(concurrency)))} assembly workers.\n` +
            `Delivery budget: ${skipPackaging ? (maxBytes ?? 'no aggregate legacy cap') : Math.min(maxBytes ?? 4_999_999_999, 4_999_999_999)} bytes. Actual candidate count/size requires source analysis.\n` +
            'Precision inputs and preparation cache are additional; they are not delivered.');
        return;
    }
    if (assemblyOnly) await resumeGlideAssembly(output, { sources, bounds, maxBytes, assemblyConcurrency });
    else await buildGlide(output, sources, { rebuild, maxBytes, bounds, refreshSources, concurrency, regionConcurrency, assemblyConcurrency });
    if (!skipPackaging) await packageGlide({ input: path.join(output, 'charts/glide/manifest.json'),
        output: packagesOutput ?? path.join(output, 'glide-packages'), maxBytes: maxBytes === undefined ? undefined : Math.min(maxBytes, 4_999_999_999) });
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(process.argv[1]).href : '')) {
    main().catch(error => { console.error(error); process.exitCode = 1; });
}
