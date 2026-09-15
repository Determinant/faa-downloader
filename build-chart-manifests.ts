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
    console.log(`Usage: node --import=tsx build-chart-manifests.ts [options]

Verifies chart build receipts and writes a manifest for each chart cycle.

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
    console.log(`Chart manifests are ready under ${chartRoot}`);
}

const entryPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entryPath) {
    main().catch(error => {
        console.error('❌ Error:', error);
        process.exitCode = 1;
    });
}
