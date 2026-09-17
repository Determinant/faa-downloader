#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { getDocument, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { replaceDirectoryAtomically, toPosixPath, writeFileAtomic } from './lib/fs-utils.ts';
import {
    discoverDtppEditions,
    pageIndexEntry,
    parseProcedureCatalog,
    parseVolumeEffectiveInterval,
    PROCEDURE_BUILDER_VERSION,
    resolveVolumePageIndexes,
    type DtppEdition,
    type IndexedPdfPage,
    type ProcedureCatalog
} from './lib/procedures.ts';

const DTPP_SEARCH_URL =
    'https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/dtpp/search/';
const DEFAULT_OUTPUT = 'dist';
const REQUEST_TIMEOUT_MS = 120_000;

type Options = {
    output: string;
    sourceXml?: string;
    effectiveDate?: string;
    help: boolean;
};

type BuildOptions = Omit<Options, 'help'> & {
    today?: string;
};

type XmlInput = {
    contents: string;
    url: string;
    expectedCycle?: string;
    expectedEffectiveDate?: string;
};

type VolumeCandidate = {
    id: string;
    filePath: string;
    url: string;
    byteLength: number;
    sha256: string;
};

export async function buildProcedureCatalog(options: BuildOptions): Promise<ProcedureCatalog> {
    const outputRoot = path.resolve(options.output);
    const xml = await loadXml(options);
    const xmlSha256 = sha256(xml.contents);
    const generatedAt = new Date().toISOString();
    const catalog = parseProcedureCatalog(xml.contents, xml.url, xmlSha256, generatedAt);
    if (xml.expectedCycle && catalog.cycle !== xml.expectedCycle) {
        throw new Error(`FAA d-TPP page selected cycle ${xml.expectedCycle}, XML has ${catalog.cycle}`);
    }
    if (xml.expectedEffectiveDate && catalog.effectiveDate !== xml.expectedEffectiveDate) {
        throw new Error(
            `FAA d-TPP page selected ${xml.expectedEffectiveDate}, ` +
            `XML is effective ${catalog.effectiveDate}`
        );
    }
    if (options.effectiveDate && catalog.effectiveDate !== options.effectiveDate) {
        throw new Error(
            `d-TPP XML is effective ${catalog.effectiveDate}, expected ${options.effectiveDate}`
        );
    }

    const catalogDirectory = path.join(
        outputRoot,
        'charts',
        catalog.effectiveDate,
        'tpp'
    );
    const volumeCandidates = await findVolumeCandidates(
        path.join(outputRoot, 'charts'),
        catalog.effectiveDate,
        catalogDirectory,
        new Set(catalog.airports.map(airport => airport.volumeId))
    );
    const existing = await readExistingCatalog(path.join(catalogDirectory, 'catalog.json'));
    if (existing &&
        isSameBuild(existing, catalog, volumeCandidates) &&
        await manifestMatches(path.join(catalogDirectory, 'manifest.json'), existing)) {
        console.log(`d-TPP catalog for ${catalog.effectiveDate} is already current`);
        return existing;
    }

    for (const volume of volumeCandidates) {
        console.log(`indexing procedure pages in "${volume.filePath}"`);
        const pages = await readPdfPages(volume.filePath);
        assertVolumeCoversDate(pages, catalog.effectiveDate, volume.filePath);
        const resolution = resolveVolumePageIndexes(catalog, volume.id, pages);
        if (resolution.unresolved > 0) {
            const targets = catalog.airports
                .filter(airport => airport.volumeId === volume.id)
                .flatMap(airport => airport.procedures
                    .filter(procedure => procedure.volumeTarget?.pageIndex === null)
                    .map(procedure => `${airport.id}: ${procedure.name} (${procedure.pdfName})`));
            throw new Error(
                `${volume.id}: ${resolution.unresolved} PDF page targets could not be resolved:\n` +
                targets.join('\n')
            );
        }
        catalog.volumes.push({
            id: volume.id,
            url: volume.url,
            byteLength: volume.byteLength,
            sha256: volume.sha256,
            pageCount: pages.length,
            resolvedTargetCount: resolution.resolved,
            unresolvedTargetCount: resolution.unresolved
        });
    }
    catalog.volumes.sort((left, right) => left.id.localeCompare(right.id));

    const manifest = createManifest(catalog);

    const cycleDirectory = path.dirname(catalogDirectory);
    await fs.mkdir(cycleDirectory, { recursive: true });
    const stagedDirectory = await fs.mkdtemp(path.join(cycleDirectory, '.tpp-'));
    try {
        await writeJson(path.join(stagedDirectory, 'catalog.json'), catalog);
        await writeJson(path.join(stagedDirectory, 'manifest.json'), manifest);
        await fs.chmod(stagedDirectory, 0o755);
        await replaceDirectoryAtomically(stagedDirectory, catalogDirectory);
    } catch (error) {
        await fs.rm(stagedDirectory, { recursive: true, force: true });
        throw error;
    }

    console.log(
        `Wrote ${manifest.procedureCount} procedures for ${catalog.airports.length} airports ` +
        `to ${catalogDirectory}`
    );
    return catalog;
}

export function parseArgs(argv: string[]): Options {
    const options: Options = { output: DEFAULT_OUTPUT, help: false };
    for (const argument of argv) {
        if (argument === '--help' || argument === '-h') {
            options.help = true;
        } else if (argument.startsWith('--output=')) {
            options.output = argument.slice('--output='.length);
        } else if (argument.startsWith('--source-xml=')) {
            options.sourceXml = argument.slice('--source-xml='.length);
        } else if (argument.startsWith('--effective-date=')) {
            options.effectiveDate = parseDateKey(argument.slice('--effective-date='.length));
        } else {
            throw new Error(`Unknown argument: ${argument}`);
        }
    }
    if (!options.output.trim()) throw new Error('--output must not be empty');
    if (options.sourceXml !== undefined && !options.sourceXml.trim()) {
        throw new Error('--source-xml must not be empty');
    }
    return options;
}

export function selectDtppEdition(
    html: string,
    baseUrl: string,
    today: string,
    effectiveDate?: string
): DtppEdition {
    const editions = discoverDtppEditions(html, baseUrl);
    const selected = effectiveDate
        ? editions.find(edition => edition.effectiveDate === effectiveDate)
        : editions.find(edition => edition.effectiveDate <= today && today < edition.expirationDate);
    if (!selected) {
        throw new Error(
            effectiveDate
                ? `FAA d-TPP page has no XML edition for ${effectiveDate}`
                : `FAA d-TPP page has no current XML edition for ${today}`
        );
    }
    return selected;
}

async function loadXml(options: BuildOptions): Promise<XmlInput> {
    if (options.sourceXml) {
        const filePath = path.resolve(options.sourceXml);
        return {
            contents: await fs.readFile(filePath, 'utf8'),
            url: pathToFileURL(filePath).href
        };
    }

    const today = options.today ?? new Date().toISOString().slice(0, 10);
    const searchHtml = await fetchText(DTPP_SEARCH_URL);
    const edition = selectDtppEdition(
        searchHtml,
        DTPP_SEARCH_URL,
        today,
        options.effectiveDate
    );
    return {
        contents: await fetchText(edition.url),
        url: edition.url,
        expectedCycle: edition.cycle,
        expectedEffectiveDate: edition.effectiveDate
    };
}

async function fetchText(url: string): Promise<string> {
    const response = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { 'user-agent': 'faa-regs-procedure-builder/1.0' }
    });
    if (!response.ok) {
        throw new Error(`FAA request failed (${response.status} ${response.statusText}): ${url}`);
    }
    return response.text();
}

async function findVolumeCandidates(
    chartsRoot: string,
    effectiveDate: string,
    catalogDirectory: string,
    requestedVolumes: ReadonlySet<string>
): Promise<VolumeCandidate[]> {
    let entries;
    try {
        entries = await fs.readdir(chartsRoot, { withFileTypes: true });
    } catch (error: any) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
    const cycles = entries
        .filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
        .map(entry => entry.name)
        .filter(cycle => cycle <= effectiveDate)
        .sort((left, right) => right.localeCompare(left));
    const candidates = new Map<string, string>();
    for (const cycle of cycles) {
        const directory = path.join(chartsRoot, cycle);
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            if (!entry.isFile()) continue;
            const match = entry.name.match(/^tpp-([a-z0-9]+)\.pdf$/i);
            const name = match?.[1].toUpperCase();
            const id = /^cs-pac\.pdf$/i.test(entry.name) ? 'PC1' : name === 'AK' ? 'AK1' : name;
            if (id && requestedVolumes.has(id) && !candidates.has(id)) {
                candidates.set(id, path.join(directory, entry.name));
            }
        }
    }

    return Promise.all([...candidates].map(async ([id, filePath]) => {
        const stat = await fs.stat(filePath);
        return {
            id,
            filePath,
            url: toPosixPath(path.relative(catalogDirectory, filePath)),
            byteLength: stat.size,
            sha256: await sha256File(filePath)
        };
    }));
}

async function readPdfPages(filePath: string): Promise<IndexedPdfPage[]> {
    const loadingTask = getDocument({
        url: filePath,
        verbosity: VerbosityLevel.ERRORS,
        useSystemFonts: true
    });
    try {
        const document = await loadingTask.promise;
        const pages: IndexedPdfPage[] = [];
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
            const page = await document.getPage(pageNumber);
            const content = await page.getTextContent();
            const textItems = content.items.flatMap(item =>
                'str' in item && item.str.trim() ? [{
                    text: item.str,
                    x: item.transform[4],
                    y: item.transform[5],
                    width: item.width
                }] : []
            );
            const [left, bottom, right, top] = page.view;
            pages.push(pageIndexEntry(
                pageNumber - 1,
                textItems,
                right - left,
                top - bottom
            ));
            page.cleanup();
        }
        return pages;
    } finally {
        await loadingTask.destroy();
    }
}

async function readExistingCatalog(filePath: string): Promise<ProcedureCatalog | null> {
    const value = await readJson(filePath);
    if (!isObject(value)) return null;
    const sourceXml = value.sourceXml;
    if (value.schemaVersion !== 1 || !isObject(sourceXml) ||
        typeof sourceXml.url !== 'string' || typeof sourceXml.sha256 !== 'string' ||
        !Array.isArray(value.airports) || !value.airports.every(airport =>
            isObject(airport) && Array.isArray(airport.procedures) &&
            airport.procedures.every(isObject)
        ) ||
        !Array.isArray(value.volumes) || !value.volumes.every(isObject)) {
        return null;
    }
    return value as ProcedureCatalog;
}

async function readJson(filePath: string): Promise<unknown | null> {
    try {
        return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error: any) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
        throw error;
    }
}

async function manifestMatches(filePath: string, catalog: ProcedureCatalog): Promise<boolean> {
    return isDeepStrictEqual(await readJson(filePath), createManifest(catalog));
}

function createManifest(catalog: ProcedureCatalog) {
    const procedures = catalog.airports.flatMap(airport => airport.procedures);
    const procedureCount = procedures.length;
    const volumeTargetCount = procedures.filter(procedure => procedure.volumeTarget).length;
    const resolvedTargetCount = catalog.volumes.reduce(
        (total, volume) => total + volume.resolvedTargetCount,
        0
    );
    const unresolvedTargetCount = catalog.volumes.reduce(
        (total, volume) => total + volume.unresolvedTargetCount,
        0
    );
    return {
        schemaVersion: 1,
        builderVersion: PROCEDURE_BUILDER_VERSION,
        cycle: catalog.cycle,
        effectiveDate: catalog.effectiveDate,
        expirationDate: catalog.expirationDate,
        generatedAt: catalog.generatedAt,
        sourceXml: catalog.sourceXml,
        airportCount: catalog.airports.length,
        procedureCount,
        volumeTargetCount,
        individualOnlyCount: procedureCount - volumeTargetCount,
        indexedTargetCount: resolvedTargetCount,
        unindexedTargetCount: volumeTargetCount - resolvedTargetCount,
        resolvedTargetCount,
        unresolvedTargetCount,
        volumes: catalog.volumes
    };
}

function assertVolumeCoversDate(
    pages: IndexedPdfPage[],
    effectiveDate: string,
    filePath: string
): void {
    const interval = pages[0] ? parseVolumeEffectiveInterval(pages[0].text) : null;
    if (!interval) throw new Error(`Cannot read effective dates from TPP volume: ${filePath}`);
    if (effectiveDate < interval.effectiveDate || effectiveDate >= interval.expirationDate) {
        throw new Error(
            `TPP volume does not cover ${effectiveDate}: ${filePath} ` +
            `(${interval.effectiveDate} through ${interval.expirationDate})`
        );
    }
}

function isSameBuild(
    existing: ProcedureCatalog,
    next: ProcedureCatalog,
    volumes: VolumeCandidate[]
): boolean {
    if (existing.sourceXml.sha256 !== next.sourceXml.sha256) return false;
    if (existing.sourceXml.url !== next.sourceXml.url) return false;
    if (existing.builderVersion !== PROCEDURE_BUILDER_VERSION) return false;
    if (existing.effectiveDate !== next.effectiveDate) return false;
    if (existing.volumes.length !== volumes.length) return false;
    const existingVolumes = new Map(existing.volumes.map(volume => [volume.id, volume]));
    return volumes.every(volume => existingVolumes.get(volume.id)?.sha256 === volume.sha256);
}

function sha256(contents: string): string {
    return createHash('sha256').update(contents).digest('hex');
}

async function sha256File(filePath: string): Promise<string> {
    const hash = createHash('sha256');
    await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(filePath);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', resolve);
    });
    return hash.digest('hex');
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
    await writeFileAtomic(filePath, `${JSON.stringify(value)}\n`);
}

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseDateKey(value: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid date: ${value}`);
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
        throw new Error(`Invalid date: ${value}`);
    }
    return value;
}

function printHelp(): void {
    console.log(`Usage: npm run build:procedures -- [options]

Builds the FAA d-TPP plate catalog in DIR/charts/YYYY-MM-DD/tpp/.
Downloads the current XML catalog unless --source-xml is provided. Indexes existing
TPP books without downloading or changing PDFs; missing books leave plate URLs
available without local page targets. SID/STAR waypoint sequences use build:nav.

Options:
  --output=DIR              Build root (default: dist)
  --source-xml=FILE         Use a local FAA d-TPP metafile
  --effective-date=DATE     Require a YYYY-MM-DD edition
  --help, -h                Show this help
`);
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) printHelp();
    else await buildProcedureCatalog(options);
}

const entryPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entryPath) {
    main().catch(error => {
        console.error('❌ Error:', error);
        process.exitCode = 1;
    });
}
