#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { writeChartManifests } from './lib/chart-tiler.ts';

type Options = {
    output: string;
    help: boolean;
};

function parseArgs(argv: string[]): Options {
    let output = 'dist';
    let help = false;
    for (const argument of argv) {
        if (argument.startsWith('--output=')) output = argument.slice('--output='.length);
        else if (argument === '--help' || argument === '-h') help = true;
        else throw new Error(`Unknown argument: ${argument}`);
    }
    if (!output.trim()) throw new Error('--output must not be empty');
    return { output: path.resolve(output), help };
}

function printHelp(): void {
    console.log(`Usage: npm run build:chart-manifests -- [options]

Relocates sheet caches into DIR/mbtiles/YYYY-MM-DD/, verifies build receipts,
and refreshes their chart-manifest.json. Existing delivery packages are flattened
into DIR/charts/YYYY-MM-DD/mbtiles/ without rerendering or recompressing tiles.
Requires gdalinfo to read archive bounds and zoom limits.
Requires existing source TIFFs and sheet MBTiles with matching receipts.
This maintenance stage can move legacy files; run on local build output before upload.
Receipts must match the current tiler configuration. Rebuild stale sheets first,
including IFR sheets made before the Lambert cutline change (see README.md).

Options:
  --output=DIR  Build root (default: dist)
  --help, -h    Show this help
`);
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        printHelp();
        return;
    }
    const chartRoot = path.join(options.output, 'charts');
    await writeChartManifests(chartRoot);
    console.log(`Chart build caches are ready under ${path.join(options.output, 'mbtiles')}; delivery files remain under ${chartRoot}`);
}

const entryPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entryPath) {
    main().catch(error => {
        console.error('❌ Error:', error);
        process.exitCode = 1;
    });
}
