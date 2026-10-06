#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { chartCutlineForFilename } from '../lib/chart-tiler.ts';
import { IFR_NEATLINES } from '../lib/ifr-neatlines.ts';
import { gdalCommand, withGdal } from '../lib/gdal.ts';
import { mapWithConcurrency } from '../lib/concurrency.ts';
import { sha256File, writeFileAtomic } from '../lib/fs-utils.ts';

/** Invert the actual FAA affine transform, including rotated chart sheets. */
export function sourcePixel([x, y]: readonly number[], transform: readonly number[]): [number, number] {
    const [originX, scaleX, skewX, originY, skewY, scaleY] = transform;
    const determinant = scaleX * scaleY - skewX * skewY;
    assert.ok(Number.isFinite(determinant) && determinant !== 0, 'Invalid source transform');
    return [((x - originX) * scaleY - (y - originY) * skewX) / determinant,
        ((y - originY) * scaleX - (x - originX) * skewY) / determinant];
}

export async function checkIfrNeatlines(sources: string) {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-neatlines-'));
    try {
        return await withGdal(4, () => mapWithConcurrency(Object.entries(IFR_NEATLINES), 4, async ([file, reference]) => {
            const source = path.join(sources, file);
            assert.equal(await sha256File(source), reference.sourceSha256, `${file}: not the reviewed reference raster`);
            const info = JSON.parse(await gdalCommand('gdalinfo', ['-json', '-noct', '-norat', source]));
            assert.deepEqual(info.size, reference.sourceSize, `${file}: source dimensions changed`);
            const [left, top, right, bottom] = reference.pixelBounds;
            const expected = [[left, top], [right, top], [right, bottom], [left, bottom], [left, top]];
            const corners = chartCutlineForFilename(file)!.wkt.slice('POLYGON (('.length, -2)
                .split(', ').map(pair => sourcePixel(pair.split(' ').map(Number), info.geoTransform));
            const maximumPixelError = Math.max(...corners.flatMap((point, index) =>
                point.map((value, axis) => Math.abs(value - expected[index][axis]))));
            assert.ok(maximumPixelError < 0.02, `${file}: cutline moved ${maximumPixelError} source pixels`);

            // Check actual source ink, not just agreement between two coordinate tables.
            // Omit corner intersections and inspect a long strip along each edge.
            const borders = [
                { edge: 'top', window: [left + 200, top, right - left - 400, 1] },
                { edge: 'bottom', window: [left + 200, bottom - 1, right - left - 400, 1] },
                { edge: 'left', window: [left, top + 200, 1, bottom - top - 400] },
                { edge: 'right', window: [right - 1, top + 200, 1, bottom - top - 400] }
            ];
            const ink: Record<string, number> = {};
            for (const border of borders) {
                const output = path.join(scratch, `${file}-${border.edge}.png`);
                await gdalCommand('gdal_translate', ['-q', '-of', 'PNG', '-srcwin',
                    ...border.window.map(String), source, output]);
                const { data, info: pixels } = await sharp(output).removeAlpha().raw().toBuffer({ resolveWithObject: true });
                let dark = 0;
                for (let offset = 0; offset < data.length; offset += pixels.channels) {
                    if (Math.max(data[offset], data[offset + 1], data[offset + 2]) < 64) dark += 1;
                }
                const fraction = dark / (pixels.width * pixels.height);
                assert.ok(fraction > 0.9, `${file}: ${border.edge} does not follow the printed frame (${fraction})`);
                ink[border.edge] = fraction;
            }
            return { file, sourceSha256: reference.sourceSha256, sourceSize: reference.sourceSize,
                pixelBounds: reference.pixelBounds, maximumPixelError, borderInkFraction: ink };
        }), ['gdalinfo', 'gdal_translate']);
    } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}

async function main() {
    let sources: string | undefined;
    let output: string | undefined;
    for (const argument of process.argv.slice(2)) {
        if (argument.startsWith('--sources=')) sources = argument.slice('--sources='.length);
        else if (argument.startsWith('--output=')) output = argument.slice('--output='.length);
        else throw new Error(`Unknown argument: ${argument}`);
    }
    if (!sources) throw new Error('Usage: npm run check:chart-neatlines -- --sources=DIR [--output=report.json]');
    const charts = await checkIfrNeatlines(sources);
    const report = { effectiveDate: '2026-09-03', charts };
    if (output) await writeFileAtomic(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Verified ${charts.length} IFR cutlines against their reference GeoTIFFs and printed borders.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => { console.error(error); process.exitCode = 1; });
}
