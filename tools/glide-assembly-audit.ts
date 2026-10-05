#!/usr/bin/env node
import { auditGlideAssembly } from '../lib/glide-assembly-resume.ts';

let output = 'dist', assemblyConcurrency: number | undefined;
for (const argument of process.argv.slice(2)) {
    if (argument.startsWith('--output=')) output = argument.slice(9);
    else if (argument.startsWith('--assembly-concurrency=')) assemblyConcurrency = Number(argument.slice(23));
    else throw new Error(`Unknown argument: ${argument}`);
}
if (!output.trim()) throw new Error('--output must be nonempty');
const report = await auditGlideAssembly(output, { assemblyConcurrency });
if (report.failedBatches) process.exitCode = 1;
