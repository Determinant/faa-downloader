#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import {
    DEFAULT_DOWNLOAD_CONCURRENCY,
    mapWithConcurrency,
    parseConcurrency
} from './lib/concurrency.ts';
import { replaceDirectoryAtomically, sha256File, writeFileAtomic } from './lib/fs-utils.ts';
import { downloadFile } from './lib/http-download.ts';
import { buildNasrProducts, type NasrInput } from './lib/nasr.ts';
import { buildRouteHistory } from './lib/route-history.ts';
import { buildTerminalProcedures, type TerminalProcedureInput } from './lib/terminal-procedures.ts';
import { extractZipEntry, listZipEntries, validateZipArchive } from './lib/zip.ts';

const NASR_INDEX_URL =
    'https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/';
const GROUPS = ['APT', 'FIX', 'NAV', 'AWY', 'PFR', 'DP', 'STAR'] as const;
const DEFAULT_RETAIN_CYCLES = 2;
const REQUIRED_FILES: Record<(typeof GROUPS)[number], string[]> = {
    APT: ['APT_BASE.csv', 'APT_RWY.csv', 'APT_RWY_END.csv'],
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
terminal procedure sequences, and Aeronautic AQ historical filed routes.
Online builds download the current FAA cycle and AQ snapshot. Local builds use
all seven CSV ZIP groups and include history only with --route-history-source.
Replaces the cycle's complete nav/ directory after all products succeed.

Options:
  --output=DIR        Build root (default: dist)
  --retain-cycles=N   Keep N NASR cycles (default: 2)
  --concurrency=N     Parallel downloads, 1-16 (default: ${DEFAULT_DOWNLOAD_CONCURRENCY})
  --source-dir=DIR    Use local APT/FIX/NAV/AWY/PFR/DP/STAR ZIP archives instead of downloading
  --route-history-source=FILE  Use a local Aeronautic AQ .sqlite or .sqlite.zst
  --cycle=YYYY-MM-DD  Local effective date; required with and only valid with --source-dir
  --help, -h          Show this help

Output layout:
  DIR/charts/YYYY-MM-DD/nav/   Map points, routes, terminal sequences, history, and manifest
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
        const match = href.match(/_(APT|FIX|NAV|AWY|PFR|DP|STAR)_CSV\.zip(?:$|[?#])/i);
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
    const match = entries.find(entry => entry.isFile() && pattern.test(entry.name));
    if (!match) throw new Error(`No ${group} CSV ZIP found in ${sourceDir}`);
    return path.join(sourceDir, match.name);
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
    const [airports, runways, runwayEnds, fixes, navaids, airways, airwaySegments,
        preferredRoutes, preferredRouteSegments] = await Promise.all([
        read('APT_BASE.csv'),
        read('APT_RWY.csv'),
        read('APT_RWY_END.csv'),
        read('FIX_BASE.csv'),
        read('NAV_BASE.csv'),
        read('AWY_BASE.csv'),
        read('AWY_SEG_ALT.csv'),
        read('PFR_BASE.csv'),
        read('PFR_SEG.csv')
    ]);
    return { airports, runways, runwayEnds, fixes, navaids, airways, airwaySegments,
        preferredRoutes, preferredRouteSegments };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
    await fs.writeFile(filePath, `${JSON.stringify(value)}\n`);
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
        if (products.effectiveDate !== acquired.cycle) {
            throw new Error(
                `NASR page cycle ${acquired.cycle} does not match CSV effective date ${products.effectiveDate}`
            );
        }
        const terminal = buildTerminalProcedures(await readTerminalInput(sourceDirectory), products.effectiveDate);

        await Promise.all([
            writeJson(path.join(stagingDirectory, 'airports.geojson'), products.airports),
            writeJson(path.join(stagingDirectory, 'fixes.geojson'), products.fixes),
            writeJson(path.join(stagingDirectory, 'vfr-waypoints.geojson'), products.vfrWaypoints),
            writeJson(path.join(stagingDirectory, 'navaids.geojson'), products.navaids),
            writeJson(path.join(stagingDirectory, 'airways.json'), products.airways),
            writeJson(path.join(stagingDirectory, 'preferred-routes.json'), products.preferredRoutes),
            writeJson(path.join(stagingDirectory, 'terminal-procedures.json'), terminal)
        ]);

        const history = await buildRouteHistory({
            outputRoot,
            effectiveDate: products.effectiveDate,
            destination: path.join(stagingDirectory, 'route-history.json.gz'),
            sourceFile: buildOptions.routeHistorySource,
            offline: Boolean(buildOptions.sourceDir)
        });

        const sourceArchives = await Promise.all(GROUPS.map(async group => ({
            group,
            url: acquired.urls[group],
            filename: path.basename(acquired.archives[group]),
            sha256: await sha256File(acquired.archives[group])
        })));
        const manifest = {
            schemaVersion: 1,
            effectiveDate: products.effectiveDate,
            generatedAt: new Date().toISOString(),
            source: NASR_INDEX_URL,
            sourceArchives,
            products: [
                { id: 'airports', file: 'airports.geojson', count: products.airports.features.length },
                { id: 'fixes', file: 'fixes.geojson', count: products.fixes.features.length },
                {
                    id: 'vfr-waypoints',
                    file: 'vfr-waypoints.geojson',
                    count: products.vfrWaypoints.features.length,
                    classification: 'FIX_USE_CODE=VFR'
                },
                { id: 'navaids', file: 'navaids.geojson', count: products.navaids.features.length },
                { id: 'airways', file: 'airways.json', count: products.airways.airways.length },
                { id: 'terminal-procedures', file: 'terminal-procedures.json', count: terminal.procedures.length },
                {
                    id: 'preferred-routes',
                    file: 'preferred-routes.json',
                    count: products.preferredRoutes.routes.length
                },
                ...(history ? [{ id: 'route-history', file: 'route-history.json.gz', compression: 'gzip', ...history }] : [])
            ]
        };
        await writeJson(path.join(stagingDirectory, 'manifest.json'), manifest);
        await fs.chmod(stagingDirectory, 0o755);
        const navigationDirectory = path.join(cycleDirectory, 'nav');
        await replaceDirectoryAtomically(stagingDirectory, navigationDirectory);
        await pruneNasrCycles(chartRoot, buildOptions.retainCycles, acquired.cycle);
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
