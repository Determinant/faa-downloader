#!/usr/bin/env node
import fs from 'node:fs/promises';
import { rebuildGlideChunks } from '../lib/glide-rebuild.ts';

let output = 'dist', plan: string | undefined, concurrency: number | undefined;
for (const argument of process.argv.slice(2)) {
    if (argument.startsWith('--output=')) output = argument.slice(9);
    else if (argument.startsWith('--plan=')) plan = argument.slice(7);
    else if (argument.startsWith('--concurrency=')) concurrency = Number(argument.slice(14));
    else throw new Error(`Unknown argument: ${argument}`);
}
if (!plan) throw new Error('Supply --plan=<verified targeted rebuild plan.json>');
await rebuildGlideChunks(output, JSON.parse(await fs.readFile(plan, 'utf8')), { concurrency });
