#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileAtomic } from './lib/fs-utils.ts';

export async function buildChartCycles(output = 'dist') {
    const root = path.resolve(output, 'charts');
    const entries = await fs.readdir(root, { withFileTypes: true });
    const cycles = entries.filter(entry => {
        if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) return false;
        const date = new Date(`${entry.name}T00:00:00Z`);
        return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === entry.name;
    }).map(entry => entry.name).sort().reverse();
    const index = { schemaVersion: 1, generatedAt: new Date().toISOString(), cycles };
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

Write DIR/charts/cycles.json from existing dated directories (default: dist).
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
