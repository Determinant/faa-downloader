#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { JSDOM } from 'jsdom';
import {
    DEFAULT_DOWNLOAD_CONCURRENCY,
    mapWithConcurrency,
    parseConcurrency
} from './lib/concurrency.ts';
import { sha256File, writeFileAtomic } from './lib/fs-utils.ts';
import { publishGeneration, stageArtifact, stageJson } from './lib/publication.ts';
import { downloadFile } from './lib/http-download.ts';
import { buildNasrProducts, type NasrInput } from './lib/nasr.ts';
import { buildRouteHistory } from './lib/route-history.ts';
import { buildMagneticModel } from './lib/magnetic-model.ts';
import type { TerminalProcedureInput } from './lib/terminal-procedures.ts';
import { buildTerminalBundle } from './lib/terminal-bundle.ts';
import { acquireCifp } from './lib/cifp-source.ts';
import { acquireChartBuildLock } from './lib/chart-build-lock.ts';
import { extractZipEntry, listZipEntries, validateZipArchive } from './lib/zip.ts';

const NASR_INDEX_URL =
    'https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/';
const GROUPS = ['APT', 'FRQ', 'FIX', 'NAV', 'AWY', 'PFR', 'DP', 'STAR'] as const;
const DEFAULT_RETAIN_CYCLES = 2;
const REQUIRED_FILES: Record<(typeof GROUPS)[number], string[]> = {
    APT: ['APT_BASE.csv', 'APT_RWY.csv', 'APT_RWY_END.csv'],
    FRQ: ['FRQ.csv'],
    FIX: ['FIX_BASE.csv'],
    NAV: ['NAV_BASE.csv'],
    AWY: ['AWY_BASE.csv', 'AWY_SEG_ALT.csv'],
    PFR: ['PFR_BASE.csv', 'PFR_SEG.csv'],
    DP: ['DP_BASE.csv', 'DP_APT.csv', 'DP_RTE.csv'],
    STAR: ['STAR_BASE.csv', 'STAR_APT.csv', 'STAR_RTE.csv']
};
const REQUEST_TIMEOUT_MS = 120_000;

type NasrGroup = (typeof GROUPS)[number];
type Options = {
    output: string;
    retainCycles: number;
    help: boolean;
    concurrency: number;
    sourceDir?: string;
    routeHistorySource?: string;
    cycle?: string;
};

function parseArgs(argv: string[]): Options {
    const options: Options = {
        output: 'dist',
        retainCycles: DEFAULT_RETAIN_CYCLES,
        concurrency: DEFAULT_DOWNLOAD_CONCURRENCY,
        help: false
    };
    for (const arg of argv) {
        if (arg === '--help' || arg === '-h') options.help = true;
        else if (arg.startsWith('--output=')) options.output = arg.slice('--output='.length);
        else if (arg.startsWith('--retain-cycles=')) {
            options.retainCycles = parseRetainCycles(arg.slice('--retain-cycles='.length));
        }
        else if (arg.startsWith('--concurrency=')) {
            options.concurrency = parseConcurrency(
                arg.slice('--concurrency='.length),
                '--concurrency'
            );
        }
        else if (arg.startsWith('--source-dir=')) options.sourceDir = arg.slice('--source-dir='.length);
        else if (arg.startsWith('--route-history-source=')) options.routeHistorySource = arg.slice('--route-history-source='.length);
        else if (arg.startsWith('--cycle=')) options.cycle = arg.slice('--cycle='.length);
        else throw new Error(`Unknown argument: ${arg}`);
    }
    validateOptions(options);
    return options;
}

function validateOptions(options: Options): void {
    if (!options.output.trim()) throw new Error('--output must not be empty');
    if (!Number.isSafeInteger(options.retainCycles) || options.retainCycles < 1) {
        throw new Error('--retain-cycles must be a positive integer');
    }
    if (options.sourceDir !== undefined && !options.sourceDir.trim()) {
        throw new Error('--source-dir must not be empty');
    }
    if (options.routeHistorySource !== undefined && !options.routeHistorySource.trim()) {
        throw new Error('--route-history-source must not be empty');
    }
    if (options.cycle !== undefined) {
        const date = new Date(`${options.cycle}T00:00:00Z`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(options.cycle)
            || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== options.cycle) {
            throw new Error('--cycle must be a valid YYYY-MM-DD date');
        }
        if (!options.sourceDir) {
            throw new Error('--cycle requires --source-dir; online builds select the current FAA cycle');
        }
    }
    if (options.sourceDir && !options.cycle) {
        throw new Error('--cycle is required with --source-dir');
    }
}

function parseRetainCycles(raw: string): number {
    if (!/^\d+$/.test(raw)) throw new Error('--retain-cycles must be a positive integer');
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error('--retain-cycles must be a positive integer');
    }
    return value;
}

function printHelp(): void {
    console.log(`Usage: npm run build:nav -- [options]

Builds the navigation bundle: FAA NASR map points, airways, preferred routes,
terminal procedure sequences and CIFP approaches, NOAA WMM geographic magnetic variation model,
and Aeronautic AQ historical filed routes.
Online builds download the current FAA cycle and AQ snapshot. Local builds use
all eight CSV ZIP groups and include history only with --route-history-source.
Local builds require FAACIFP18 or the matching CIFP_YYMMDD.zip in --source-dir.
Missing terminal sources fail the build and preserve the existing nav/ bundle.
Replaces the cycle's complete nav/ directory after all products succeed.

Options:
  --output=DIR        Build root (default: dist)
  --retain-cycles=N   Keep N NASR cycles (default: 2)
  --concurrency=N     Parallel downloads, 1-16 (default: ${DEFAULT_DOWNLOAD_CONCURRENCY})
  --source-dir=DIR    Use local APT/FRQ/FIX/NAV/AWY/PFR/DP/STAR ZIP archives instead of downloading
  --route-history-source=FILE  Use a local Aeronautic AQ .sqlite or .sqlite.zst
  --cycle=YYYY-MM-DD  Local effective date; required with and only valid with --source-dir
  --help, -h          Show this help

Output layout:
  DIR/charts/YYYY-MM-DD/nav/   Map points, routes, magnetic model, history, and manifest
  DIR/charts/YYYY-MM-DD/nasr/  Reusable FAA source ZIP archives
`);
}

async function request(url: string): Promise<Response> {
    return fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { 'user-agent': 'faa-regs-nasr-builder/1.0' }
    });
}

async function fetchText(url: string): Promise<string> {
    const response = await request(url);
    if (!response.ok) {
        throw new Error(`FAA request failed (${response.status} ${response.statusText}): ${url}`);
    }
    return response.text();
}

export function discoverCurrentNasrCycle(
    html: string,
    baseUrl = NASR_INDEX_URL,
    today = new Date().toISOString().slice(0, 10)
): { cycle: string; url: string } {
    const dom = new JSDOM(html, { url: baseUrl });
    const anchors = Array.from(dom.window.document.querySelectorAll('a')) as any[];
    const candidates = anchors
        .map(anchor => new URL(String(anchor.getAttribute('href') || ''), baseUrl))
        .flatMap(url => {
            const match = url.pathname.match(/\/NASR_Subscription\/(\d{4}-\d{2}-\d{2})\/?$/);
            return match && match[1] <= today ? [{ cycle: match[1], url: url.href }] : [];
        })
        .sort((left, right) => right.cycle.localeCompare(left.cycle));

    if (!candidates[0]) throw new Error('FAA NASR page contains no current effective cycle');
    return candidates[0];
}

export function discoverNasrGroupUrls(
    html: string,
    baseUrl: string
): Record<NasrGroup, string> {
    const dom = new JSDOM(html, { url: baseUrl });
    const found = new Map<NasrGroup, string>();
    const anchors = Array.from(dom.window.document.querySelectorAll('a')) as any[];
    for (const anchor of anchors) {
        const href = String(anchor.getAttribute('href') || '');
        const match = href.match(/_(APT|FRQ|FIX|NAV|AWY|PFR|DP|STAR)_CSV\.zip(?:$|[?#])/i);
        if (!match) continue;
        const group = match[1].toUpperCase() as NasrGroup;
        found.set(group, new URL(href, baseUrl).href);
    }
    const missing = GROUPS.filter(group => !found.has(group));
    if (missing.length > 0) throw new Error(`FAA NASR cycle is missing CSV groups: ${missing.join(', ')}`);
    return Object.fromEntries(GROUPS.map(group => [group, found.get(group)])) as Record<NasrGroup, string>;
}

export async function downloadNasrFile(url: string, destination: string): Promise<void> {
    await downloadFile(url, destination, {
        userAgent: 'faa-regs-nasr-builder/1.0',
        validate: validateZipArchive
    });
}

async function findLocalArchive(sourceDir: string, group: NasrGroup): Promise<string> {
    const entries = await fs.readdir(sourceDir, { withFileTypes: true });
    const pattern = new RegExp(`(?:^|_)${group}(?:_CSV)?\\.zip$`, 'i');
    const matches = entries.filter(entry => entry.isFile() && pattern.test(entry.name));
    if (matches.length !== 1) throw new Error(`Expected one ${group} CSV ZIP in ${sourceDir}; found ${matches.length}`);
    return path.join(sourceDir, matches[0].name);
}

async function acquireArchives(
    options: Options,
    rawDirectoryForCycle: (cycle: string) => string
): Promise<{ cycle: string; archives: Record<NasrGroup, string>; urls: Record<NasrGroup, string> }> {
    if (options.sourceDir) {
        const rawDirectory = rawDirectoryForCycle(options.cycle);
        await fs.mkdir(rawDirectory, { recursive: true });
        const sourceDir = path.resolve(options.sourceDir);
        const archives = {} as Record<NasrGroup, string>;
        const urls = {} as Record<NasrGroup, string>;
        for (const group of GROUPS) {
            const source = await findLocalArchive(sourceDir, group);
            const destination = path.join(rawDirectory, path.basename(source));
            urls[group] = pathToFileURL(source).href;
            if (path.resolve(source) !== path.resolve(destination)) {
                await writeFileAtomic(destination, await fs.readFile(source));
            }
            archives[group] = destination;
        }
        return { cycle: options.cycle, archives, urls };
    }

    const indexHtml = await fetchText(NASR_INDEX_URL);
    const current = discoverCurrentNasrCycle(indexHtml);
    const cycleHtml = await fetchText(current.url);
    const urls = discoverNasrGroupUrls(cycleHtml, current.url);
    const rawDirectory = rawDirectoryForCycle(current.cycle);
    await fs.mkdir(rawDirectory, { recursive: true });
    const downloaded = await mapWithConcurrency(GROUPS, options.concurrency, async group => {
        const filename = path.basename(new URL(urls[group]).pathname);
        const destination = path.join(rawDirectory, filename);
        await downloadNasrFile(urls[group], destination);
        return [group, destination] as const;
    });
    const archives = Object.fromEntries(downloaded) as Record<NasrGroup, string>;
    return { cycle: current.cycle, archives, urls };
}

async function extractRequiredFiles(
    archives: Record<NasrGroup, string>,
    sourceDirectory: string
): Promise<void> {
    await fs.mkdir(sourceDirectory, { recursive: true });
    for (const group of GROUPS) {
        const required = new Set(REQUIRED_FILES[group]);
        await validateZipArchive(archives[group]);
        const entries = await listZipEntries(archives[group]);
        for (const filename of required) {
            const matches = entries.filter(entry => entry === filename);
            if (matches.length !== 1) {
                throw new Error(
                    `${path.basename(archives[group])} contains ${matches.length} entries for ${filename}`
                );
            }
            await extractZipEntry(archives[group], matches[0], path.join(sourceDirectory, filename));
        }
    }
}

async function readNasrInput(sourceDirectory: string): Promise<NasrInput> {
    const read = (filename: string) => fs.readFile(path.join(sourceDirectory, filename), 'utf8');
    const [airports, runways, runwayEnds, frequencies, fixes, navaids, airways, airwaySegments,
        preferredRoutes, preferredRouteSegments] = await Promise.all([
        read('APT_BASE.csv'),
        read('APT_RWY.csv'),
        read('APT_RWY_END.csv'),
        read('FRQ.csv'),
        read('FIX_BASE.csv'),
        read('NAV_BASE.csv'),
        read('AWY_BASE.csv'),
        read('AWY_SEG_ALT.csv'),
        read('PFR_BASE.csv'),
        read('PFR_SEG.csv')
    ]);
    return { airports, runways, runwayEnds, frequencies, fixes, navaids, airways, airwaySegments,
        preferredRoutes, preferredRouteSegments };
}

async function readTerminalInput(sourceDirectory: string): Promise<TerminalProcedureInput> {
    const read = (filename: string) => fs.readFile(path.join(sourceDirectory, filename), 'utf8');
    const [departures, departureAirports, departureRoutes, arrivals, arrivalAirports, arrivalRoutes] = await Promise.all(
        ['DP_BASE.csv', 'DP_APT.csv', 'DP_RTE.csv', 'STAR_BASE.csv', 'STAR_APT.csv', 'STAR_RTE.csv'].map(read)
    );
    return { departures, departureAirports, departureRoutes, arrivals, arrivalAirports, arrivalRoutes };
}

export async function pruneNasrCycles(
    chartRoot: string,
    retainCycles: number,
    preserveCycle?: string
): Promise<void> {
    if (!Number.isSafeInteger(retainCycles) || retainCycles < 1) {
        throw new Error('retainCycles must be a positive integer');
    }

    let entries;
    try {
        entries = await fs.readdir(chartRoot, { withFileTypes: true });
    } catch (error: any) {
        if (error.code === 'ENOENT') return;
        throw error;
    }

    const cycles: string[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
        const cycleDirectory = path.join(chartRoot, entry.name);
        const containsNasr = await Promise.all(['nav', 'nasr'].map(async name => {
            try {
                return (await fs.stat(path.join(cycleDirectory, name))).isDirectory();
            } catch (error: any) {
                if (error.code === 'ENOENT') return false;
                throw error;
            }
        }));
        if (containsNasr.some(Boolean)) cycles.push(entry.name);
    }

    cycles.sort((left, right) => right.localeCompare(left));
    const retained = preserveCycle && cycles.includes(preserveCycle)
        ? new Set([
            preserveCycle,
            ...cycles.filter(cycle => cycle !== preserveCycle).slice(0, retainCycles - 1)
        ])
        : new Set(cycles.slice(0, retainCycles));
    for (const cycle of cycles.filter(cycle => !retained.has(cycle))) {
        const cycleDirectory = path.join(chartRoot, cycle);
        await Promise.all(['nav', 'nasr'].map(name => (
            fs.rm(path.join(cycleDirectory, name), { recursive: true, force: true })
        )));
        try {
            await fs.rmdir(cycleDirectory);
        } catch (error: any) {
            if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
        }
        console.log(`removed stale NASR cycle "${cycle}"`);
    }
}

type NasrBuildOptions = Pick<Options, 'output' | 'sourceDir' | 'cycle' | 'routeHistorySource'> & {
    retainCycles?: number;
    concurrency?: number;
};

export async function buildNasrData(options: NasrBuildOptions): Promise<void> {
    const buildOptions: Options = {
        ...options,
        output: options.output ?? 'dist',
        retainCycles: options.retainCycles ?? DEFAULT_RETAIN_CYCLES,
        concurrency: parseConcurrency(
            options.concurrency ?? DEFAULT_DOWNLOAD_CONCURRENCY
        ),
        help: false
    };
    validateOptions(buildOptions);
    const outputRoot = path.resolve(buildOptions.output);
    const chartRoot = path.join(outputRoot, 'charts');
    await fs.mkdir(chartRoot, { recursive: true });

    const release = await acquireChartBuildLock(path.join(chartRoot, '.navigation'));
    try {
        await buildNavigationCycle(buildOptions, outputRoot, chartRoot);
    } finally {
        await release();
    }
}

async function buildNavigationCycle(buildOptions: Options, outputRoot: string, chartRoot: string): Promise<void> {
    const acquired = await acquireArchives(
        buildOptions,
        cycle => path.join(chartRoot, cycle, 'nasr')
    );
    const cycleDirectory = path.join(chartRoot, acquired.cycle);

    await fs.mkdir(cycleDirectory, { recursive: true });
    const sourceDirectory = await fs.mkdtemp(path.join(outputRoot, '.nasr-source-'));
    const stagingDirectory = await fs.mkdtemp(path.join(cycleDirectory, '.nav-build-'));

    try {
        await extractRequiredFiles(acquired.archives, sourceDirectory);
        const products = buildNasrProducts(await readNasrInput(sourceDirectory));
        for (const [name, count] of [['airports', products.airports.features.length], ['fixes', products.fixes.features.length],
            ['navaids', products.navaids.features.length], ['airways', products.airways.airways.length]] as const) {
            if (!count) throw new Error(`NASR projection contains no ${name}; inspect source validation and exclusions before publishing`);
        }
        if (products.effectiveDate !== acquired.cycle) {
            throw new Error(
                `NASR page cycle ${acquired.cycle} does not match CSV effective date ${products.effectiveDate}`
            );
        }
        const cifp = await acquireCifp(products.effectiveDate, path.join(cycleDirectory, 'nasr'), buildOptions.sourceDir);
        const terminal = buildTerminalBundle(await readTerminalInput(sourceDirectory), cifp.text, products.effectiveDate, cifp.source);
        const magneticModel = await buildMagneticModel(products.effectiveDate);
        const magneticModelFile = 'magnetic-model.json';

        const definitions = [
            ['airports', 'airports.geojson', products.airports, products.airports.features.length],
            ['fixes', 'fixes.geojson', products.fixes, products.fixes.features.length],
            ['vfr-waypoints', 'vfr-waypoints.geojson', products.vfrWaypoints, products.vfrWaypoints.features.length],
            ['navaids', 'navaids.geojson', products.navaids, products.navaids.features.length],
            ['airways', 'airways.json', products.airways, products.airways.airways.length],
            ['preferred-routes', 'preferred-routes.json', products.preferredRoutes, products.preferredRoutes.routes.length],
            ['terminal-procedures', 'terminal-procedures.json', terminal, terminal.procedures.length],
            ['magnetic-model', magneticModelFile, magneticModel, magneticModel.coefficients.length],
            ['nasr-coverage', 'nasr-coverage.json', { effectiveDate: products.effectiveDate,
                tables: products.coverage, excluded: products.excluded }, products.excluded.length],
        ] as const;
        const artifacts = await Promise.all(definitions.map(async ([id, name, data, count]) => ({
            id, count, ...await stageJson(stagingDirectory, name, data),
            ...(id === 'terminal-procedures' ? { schemaVersion: 2, coverage: terminal.coverage } : {}),
            ...(id === 'vfr-waypoints' ? { classification: 'FIX_USE_CODE=VFR' } : {}),
            ...(id === 'magnetic-model' ? { model: magneticModel.model, validFrom: magneticModel.validFrom,
                validUntil: magneticModel.validUntil, source: magneticModel.source } : {}),
        })));
        const sourceArtifact = await stageArtifact(stagingDirectory, 'cifp-source.txt.gz', gzipSync(cifp.text));

        const history = await buildRouteHistory({
            outputRoot,
            effectiveDate: products.effectiveDate,
            destination: path.join(stagingDirectory, 'route-history.json.gz'),
            sourceFile: buildOptions.routeHistorySource,
            offline: Boolean(buildOptions.sourceDir)
        });
        let historyArtifact;
        if (history) {
            const file = path.join(stagingDirectory, 'route-history.json.gz');
            historyArtifact = await stageArtifact(stagingDirectory, 'route-history.json.gz', await fs.readFile(file));
            await fs.rm(file);
        }

        const sourceArchives = [...await Promise.all(GROUPS.map(async group => ({
            group,
            url: acquired.urls[group],
            filename: path.basename(acquired.archives[group]),
            sha256: await sha256File(acquired.archives[group])
        }))), cifp.source];
        const manifest = {
            schemaVersion: 2,
            effectiveDate: products.effectiveDate,
            generatedAt: new Date().toISOString(),
            source: NASR_INDEX_URL,
            sourceArchives,
            products: [
                ...artifacts,
                { id: 'cifp-source', ...sourceArtifact, compression: 'gzip',
                    count: cifp.text.split(/\r?\n/).filter(Boolean).length,
                    decodedSha256: cifp.source.recordFile.sha256 },
                ...(history ? [{ id: 'route-history', compression: 'gzip', ...history, ...historyArtifact }] : [])
            ]
        };
        const navigationDirectory = path.join(cycleDirectory, 'nav');
        await publishGeneration(stagingDirectory, navigationDirectory, manifest);
        await pruneNasrCycles(chartRoot, buildOptions.retainCycles, acquired.cycle);
        console.log(`Terminal coverage: ${JSON.stringify(terminal.coverage)}`);
        console.log(`NASR navigation data is ready under ${navigationDirectory}`);
    } finally {
        await fs.rm(sourceDirectory, { recursive: true, force: true });
        await fs.rm(stagingDirectory, { recursive: true, force: true });
    }
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) printHelp();
    else await buildNasrData(options);
}

const entryPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entryPath) {
    main().catch(error => {
        console.error('❌ Error:', error);
        process.exitCode = 1;
    });
}
