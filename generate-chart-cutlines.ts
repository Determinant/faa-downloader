#!/usr/bin/env node

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { configuredRasterFilenames } from './lib/chart-discovery.ts';
import { mapWithConcurrency } from './lib/concurrency.ts';
import { writeFileAtomic } from './lib/fs-utils.ts';

const CHARTMAKER_COMMIT = '1d71db443916b8052dde41d612c3311bac25a5ae';
const EXPECTED_CUTLINE_COUNT = 129;
const OUTPUT_PATH = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'lib/chartmaker-cutlines.ts'
);
const execFileAsync = promisify(execFile);

type Options = {
    chartmaker?: string;
    write: boolean;
    help: boolean;
};

type CutlineSource = {
    relativePath: string;
    polygonIndex?: number;
};

type LongitudeLatitude = [longitude: number, latitude: number];

function parseArgs(argv: string[]): Options {
    const options: Options = { write: false, help: false };
    let mode: '--check' | '--write' | undefined;
    for (const argument of argv) {
        if (argument === '--write' || argument === '--check') {
            if (mode && mode !== argument) {
                throw new Error('--check and --write are mutually exclusive');
            }
            mode = argument;
            options.write = argument === '--write';
        }
        else if (argument === '--help' || argument === '-h') options.help = true;
        else if (argument.startsWith('--chartmaker=')) {
            options.chartmaker = argument.slice('--chartmaker='.length);
        } else {
            throw new Error(`Unknown argument: ${argument}`);
        }
    }
    if (!options.help && !options.chartmaker?.trim()) {
        throw new Error('--chartmaker must point to the pinned chartmaker checkout');
    }
    return options;
}

function printHelp(): void {
    console.log(`Usage: npm run chart-cutlines -- --chartmaker=DIR [--check|--write]

Regenerates or verifies the community chart cutlines using a local checkout of
N129BZ/chartmaker at ${CHARTMAKER_COMMIT}.

Options:
  --chartmaker=DIR  chartmaker repository root (required)
  --check           Verify the generated module is current (default)
  --write           Replace the generated module atomically
  --help, -h        Show this help
`);
}

async function runCommand(command: string, args: string[]): Promise<string> {
    try {
        const result = await execFileAsync(command, args, { maxBuffer: 16 * 1024 * 1024 });
        return result.stdout;
    } catch (error: any) {
        const detail = String(error.stderr || error.stdout || error.message || error).trim();
        throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
    }
}

async function verifyChartmakerCheckout(checkout: string): Promise<void> {
    const revision = (await runCommand('git', ['-C', checkout, 'rev-parse', 'HEAD'])).trim();
    if (revision !== CHARTMAKER_COMMIT) {
        throw new Error(`chartmaker must be checked out at ${CHARTMAKER_COMMIT}; found ${revision}`);
    }
    const changes = await runCommand('git', [
        '-C', checkout, 'status', '--porcelain', '--untracked-files=no', '--', 'clipshapes'
    ]);
    if (changes.trim()) throw new Error('chartmaker clipshapes contain local modifications');
}

function sourceForFilename(filename: string): CutlineSource {
    const withoutExtension = filename.replace(/\.tif$/i, '');
    if (withoutExtension.startsWith('ifr-enroute-low-')) {
        const name = withoutExtension.slice('ifr-enroute-low-'.length);
        return { relativePath: `enroute_low/enr_${name}.shp` };
    }
    if (withoutExtension.startsWith('vfr-terminal-')) {
        const name = withoutExtension.slice('vfr-terminal-'.length).replaceAll('-', '_');
        return { relativePath: `terminal/${name}.shp` };
    }
    if (!withoutExtension.startsWith('vfr-sectional-')) {
        throw new Error(`Unsupported community cutline filename: ${filename}`);
    }

    const name = withoutExtension.slice('vfr-sectional-'.length);
    if (name === 'western_aleutian_islands-east-eastern_hemisphere') {
        return {
            relativePath: 'sectional/western_aleutian_islands_east.shp',
            polygonIndex: 0
        };
    }
    if (name === 'western_aleutian_islands-east-western_hemisphere') {
        return {
            relativePath: 'sectional/western_aleutian_islands_east.shp',
            polygonIndex: 1
        };
    }
    const sourceName = name === 'western_aleutian_islands-west'
        ? 'western_aleutian_islands_west'
        : name.replaceAll('-', '_');
    return { relativePath: `sectional/${sourceName}.shp` };
}

function isCoordinate(value: unknown): value is [number, number] {
    return Array.isArray(value) && value.length >= 2 &&
        typeof value[0] === 'number' && Number.isFinite(value[0]) &&
        typeof value[1] === 'number' && Number.isFinite(value[1]);
}

function sameCoordinate(left: [number, number], right: [number, number]): boolean {
    return Math.abs(left[0] - right[0]) < 1e-7 && Math.abs(left[1] - right[1]) < 1e-7;
}

function equalCoordinate(left: [number, number], right: [number, number]): boolean {
    return left[0] === right[0] && left[1] === right[1];
}

function normalizeRing(value: unknown, filename: string): LongitudeLatitude[] {
    if (!Array.isArray(value) || !value.every(isCoordinate) || value.length < 4) {
        throw new Error(`Invalid outer ring for ${filename}`);
    }
    if (!sameCoordinate(value[0], value.at(-1)!)) {
        throw new Error(`Open source ring for ${filename}`);
    }

    const normalized = value.slice(0, -1).map(([rawLongitude, rawLatitude]) => {
        const roundedLongitude = Number(rawLongitude.toFixed(7));
        const longitude = roundedLongitude === 180 ? 179.9999999 : roundedLongitude;
        const latitude = Number(rawLatitude.toFixed(7));
        return [Object.is(longitude, -0) ? 0 : longitude,
            Object.is(latitude, -0) ? 0 : latitude] as LongitudeLatitude;
    }).filter((coordinate, index, coordinates) =>
        index === 0 || !equalCoordinate(coordinate, coordinates[index - 1])
    );
    if (normalized.length < 3) throw new Error(`Degenerate cutline for ${filename}`);
    return normalized;
}

function outerRingForGeometry(
    geometry: unknown,
    source: CutlineSource,
    filename: string
): LongitudeLatitude[] {
    if (!geometry || typeof geometry !== 'object') {
        throw new Error(`Missing geometry for ${filename}`);
    }
    const { type, coordinates } = geometry as Record<string, unknown>;
    if (type === 'Polygon' && source.polygonIndex === undefined) {
        if (!Array.isArray(coordinates) || coordinates.length !== 1) {
            throw new Error(`Expected one Polygon ring for ${filename}`);
        }
        return normalizeRing(coordinates[0], filename);
    }
    if (type === 'MultiPolygon' && source.polygonIndex !== undefined) {
        const polygon = Array.isArray(coordinates)
            ? coordinates[source.polygonIndex]
            : undefined;
        if (!Array.isArray(polygon) || polygon.length !== 1) {
            throw new Error(`Expected one MultiPolygon ring for ${filename}`);
        }
        return normalizeRing(polygon[0], filename);
    }
    throw new Error(`Unexpected geometry type for ${filename}: ${String(type ?? 'missing')}`);
}

async function loadCutline(
    checkout: string,
    filename: string
): Promise<[string, LongitudeLatitude[]]> {
    const source = sourceForFilename(filename);
    const sourcePath = path.join(checkout, 'clipshapes', source.relativePath);
    const raw = await runCommand('ogr2ogr', [
        '-f', 'GeoJSON', '/vsistdout/', sourcePath, '-t_srs', 'EPSG:4326'
    ]);
    const featureCollection = JSON.parse(raw);
    if (featureCollection?.features?.length !== 1) {
        throw new Error(`Expected one feature in ${source.relativePath}`);
    }
    return [
        filename,
        outerRingForGeometry(featureCollection.features[0].geometry, source, filename)
    ];
}

function renderCutlines(entries: Array<[string, LongitudeLatitude[]]>): string {
    const lines = [
        '// Generated by generate-chart-cutlines.ts. Do not edit manually.',
        `// Source: https://github.com/N129BZ/chartmaker/tree/${CHARTMAKER_COMMIT}/clipshapes`,
        '// License: MIT; see THIRD_PARTY_NOTICES.md.',
        '// Regenerate: npm run chart-cutlines -- --chartmaker=/path/to/chartmaker --write',
        '',
        `export const CHARTMAKER_COMMIT = '${CHARTMAKER_COMMIT}' as const;`,
        '',
        'export type LongitudeLatitude = readonly [longitude: number, latitude: number];',
        '',
        'export const CHARTMAKER_CUTLINES = {'
    ];
    for (const [filename, coordinates] of entries) {
        lines.push(`    '${filename}': [`);
        for (const [longitude, latitude] of coordinates) {
            lines.push(`        [${longitude.toFixed(7)}, ${latitude.toFixed(7)}],`);
        }
        lines.push('    ],');
    }
    lines.push(
        '} satisfies Readonly<Record<string, readonly LongitudeLatitude[]>>;',
        ''
    );
    return lines.join('\n');
}

async function buildGeneratedModule(checkout: string): Promise<string> {
    await verifyChartmakerCheckout(checkout);
    const filenames = configuredRasterFilenames()
        .filter(filename => !filename.endsWith('-flyway.tif'));
    if (filenames.length !== EXPECTED_CUTLINE_COUNT) {
        throw new Error(
            `Expected ${EXPECTED_CUTLINE_COUNT} community cutlines; found ${filenames.length}`
        );
    }
    const entries = await mapWithConcurrency(
        filenames,
        4,
        filename => loadCutline(checkout, filename)
    );
    return renderCutlines(entries);
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        printHelp();
        return;
    }
    const expected = await buildGeneratedModule(path.resolve(options.chartmaker!));
    if (options.write) {
        await writeFileAtomic(OUTPUT_PATH, expected);
        console.log(`Wrote ${OUTPUT_PATH}`);
        return;
    }
    const current = await fs.readFile(OUTPUT_PATH, 'utf8').catch(error => {
        if (error?.code === 'ENOENT') return '';
        throw error;
    });
    if (current !== expected) {
        throw new Error(
            'Generated cutlines are stale; rerun with --write and review the resulting diff'
        );
    }
    console.log(`Verified ${EXPECTED_CUTLINE_COUNT} generated community cutlines.`);
}

const entryPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entryPath) {
    main().catch(error => {
        console.error('❌ Error:', error);
        process.exitCode = 1;
    });
}
