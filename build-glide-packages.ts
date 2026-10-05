#!/usr/bin/env node
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { packageGlide, type PackageGlideOptions } from './lib/glide-packager.ts';
import { exportGlidePackages, verifyGlidePackages } from './lib/glide-package-verify.ts';

export async function main(args = process.argv.slice(2)): Promise<void> {
    const options: Partial<PackageGlideOptions> = {};
    let verify = false;
    let exportTo: string | undefined;
    for (const arg of args) {
        if (arg.startsWith('--input=')) options.input = arg.slice(8);
        else if (arg.startsWith('--output=')) options.output = arg.slice(9);
        else if (arg.startsWith('--regions=')) options.regions = JSON.parse(await fs.readFile(arg.slice(10), 'utf8'));
        else if (arg.startsWith('--max-bytes=')) options.maxBytes = Number(arg.slice(12));
        else if (arg.startsWith('--overview-zoom=')) options.overviewZoom = Number(arg.slice(16));
        else if (arg.startsWith('--concurrency=')) options.concurrency = Number(arg.slice(14));
        else if (arg === '--force-packaging') options.forcePackaging = true;
        else if (arg === '--reassemble') options.reassemble = true;
        else if (arg === '--verify') verify = true;
        else if (arg.startsWith('--export-active=')) exportTo = arg.slice(16);
        else if (arg === '--help' || arg === '-h') {
            console.log('Usage: npm run build:glide-packages -- --input=MANIFEST --output=SEPARATE_ROOT [--regions=FILE] [--overview-zoom=10|11] [--max-bytes=BYTES] [--concurrency=1..8] [--force-packaging] [--reassemble]\n' +
                'Losslessly repackage a completed schema-8/9 glide publication from any engine version.\n' +
                'No source downloads, terrain analysis or automatic rebuild fallback.\n' +
                '--reassemble requires a complete frozen analysis snapshot and GDAL; reruns only final assembly.\n' +
                '--verify --output=ROOT independently checks an existing new-format release without packaging.\n' +
                '--export-active=NEW_ROOT --output=ROOT verifies and exports only the active release.\n' +
                'Output: ROOT/charts/glide/; resumable inputs/checkpoints/report: ROOT/glide-package-cache/.\n' +
                'The old publication is preserved. ZLayer needs the new decoder before using this feed.'); return;
        } else throw new Error(`Unknown packaging option: ${arg}`);
    }
    if (verify || exportTo !== undefined) {
        if (!options.output?.trim() || options.input || options.reassemble || options.forcePackaging) throw new Error('--verify requires --output and cannot rebuild or select another input');
        if (exportTo !== undefined) {
            if (!exportTo.trim()) throw new Error('--export-active requires a new output root');
            await exportGlidePackages(options.output, exportTo);
        } else await verifyGlidePackages(options.output);
        return;
    }
    if (!options.input?.trim() || !options.output?.trim()) throw new Error('Packaging requires --input=MANIFEST and an explicit separate --output=ROOT');
    await packageGlide(options as PackageGlideOptions);
}
if (import.meta.url === (process.argv[1] ? pathToFileURL(process.argv[1]).href : '')) {
    main().catch(error => { console.error(error); process.exitCode = 1; });
}
