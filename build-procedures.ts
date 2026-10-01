#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { airacCycleForDate, faaEffectiveDate } from './lib/faa-effective-date.ts';
import { isDeepStrictEqual } from 'node:util';
import { getDocument, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { acquireChartBuildLock } from './lib/chart-build-lock.ts';
import { downloadFile } from './lib/http-download.ts';
import { pdfBookFolder } from './lib/pdf-layout.ts';
import { pdfBookSources, publishPdfBook } from './lib/pdf-books.ts';
import { jsonArtifact, pruneGeneration, publishGeneration, stageJson } from './lib/publication.ts';
import { publishedApproachAssociations } from './lib/approach-associations.ts';
import {
    FAA_DTPP_BASE_URL,
    pageIndexEntry,
    parseProcedureCatalog,
    parseVolumeEffectiveInterval,
    PROCEDURE_BUILDER_VERSION,
    resolveVolumePageIndexes,
    type IndexedPdfPage,
    type ProcedureCatalog
} from './lib/procedures.ts';

const DEFAULT_OUTPUT = 'dist';

type Options = {
    output: string;
    sourceXml?: string;
    effectiveDate?: string;
    help: boolean;
};

type BuildOptions = Omit<Options, 'help'> & {
    today?: string;
};

type VolumeCandidate = {
    id: string;
    filePath: string;
    url: string;
    byteLength: number;
    sha256: string;
};

export async function buildProcedureCatalog(options: BuildOptions): Promise<ProcedureCatalog> {
    return (await prepareProcedureCatalog(options)).build();
}

/** Validate and retain the XML before expensive chart work. Books and navigation
 * associations are read only when build() runs, after those stages have finished.
 */
export async function prepareProcedureCatalog(options: BuildOptions): Promise<{
    readonly effectiveDate: string;
    build: () => Promise<ProcedureCatalog>;
}> {
    const outputRoot = path.resolve(options.output);
    const catalog = await loadCatalog(options);
    return {
        effectiveDate: catalog.effectiveDate,
        build: () => publishCatalog(outputRoot, structuredClone(catalog))
    };
}

async function publishCatalog(outputRoot: string, catalog: ProcedureCatalog): Promise<ProcedureCatalog> {
    catalog.generatedAt = new Date().toISOString();
    const catalogDirectory = path.join(
        outputRoot,
        'charts',
        catalog.effectiveDate,
        'tpp'
    );
    const cycleDirectory = path.dirname(catalogDirectory);
    await fs.mkdir(cycleDirectory, { recursive: true });
    const release = await acquireChartBuildLock(path.join(cycleDirectory, '.tpp'));
    try {
        const volumeCandidates = await findVolumeCandidates(
            outputRoot,
            catalog.effectiveDate,
            catalogDirectory,
            new Set(catalog.airports.flatMap(airport => [airport.volumeId,
                ...airport.procedures.flatMap(procedure => procedure.volumeTarget ? [procedure.volumeTarget.volumeId] : [])]))
        );
        const existingManifest = await readJson(path.join(catalogDirectory, 'manifest.json'));
        const existingFile = isObject(existingManifest) && typeof existingManifest.file === 'string' &&
            /^catalog\.[a-f0-9]{64}\.json$/.test(existingManifest.file) ? existingManifest.file : 'catalog.json';
        const existing = await readExistingCatalog(path.join(catalogDirectory, existingFile));
        const associations = await publishedApproachAssociations(catalog, path.join(path.dirname(catalogDirectory), 'nav'));
        if (associations) catalog.associations = associations;
        const reuse = existing && isSameBuild(existing, catalog, volumeCandidates);
        if (reuse && volumeCandidates.every(volume =>
            existing.volumes.find(current => current.id === volume.id)?.url === volume.url) &&
            isDeepStrictEqual(existing.associations, catalog.associations) &&
            await manifestMatches(path.join(catalogDirectory, 'manifest.json'), existing)) {
            await pruneGeneration(catalogDirectory, [existingFile], name => pdfBookFolder(name) === 'tpp');
            console.log(`d-TPP catalog for ${catalog.effectiveDate} is already current`);
            return existing;
        }

        if (reuse) {
            catalog.airports = existing.airports;
            const byId = new Map(volumeCandidates.map(volume => [volume.id, volume]));
            catalog.volumes = existing.volumes.map(volume => {
                const source = byId.get(volume.id)!;
                return { ...volume, url: source.url, byteLength: source.byteLength, sha256: source.sha256 };
            });
        }
        for (const volume of reuse ? [] : volumeCandidates) {
            console.log(`indexing procedure pages in "${volume.filePath}"`);
            const pages = await readPdfPages(volume.filePath);
            if ((await fs.stat(volume.filePath)).size !== volume.byteLength ||
                await sha256File(volume.filePath) !== volume.sha256) {
                throw new Error(`Procedure PDF changed while indexing: ${volume.filePath}`);
            }
            assertVolumeCoversDate(pages, catalog.effectiveDate, volume.filePath);
            const resolution = resolveVolumePageIndexes(catalog, volume.id, pages);
            if (resolution.unresolved > 0) {
                const targets = catalog.airports
                    .flatMap(airport => airport.procedures
                        .filter(procedure => procedure.volumeTarget?.volumeId === volume.id && procedure.volumeTarget.pageIndex === null)
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

        const stagedDirectory = await fs.mkdtemp(path.join(cycleDirectory, '.tpp-'));
        try {
            await stageJson(stagedDirectory, 'catalog.json', catalog);
            await publishGeneration(stagedDirectory, catalogDirectory, manifest);
            await pruneGeneration(catalogDirectory, [manifest.file], name => pdfBookFolder(name) === 'tpp');
        } finally {
            await fs.rm(stagedDirectory, { recursive: true, force: true });
        }

        console.log(
            `Wrote ${manifest.procedureCount} procedures for ${catalog.airports.length} airports ` +
            `to ${catalogDirectory}`
        );
        return catalog;
    } finally { await release(); }
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

async function loadCatalog(options: BuildOptions): Promise<ProcedureCatalog> {
    const requested = options.effectiveDate === undefined ? undefined : airacCycleForDate(options.effectiveDate);
    if (requested && requested.effectiveDate !== options.effectiveDate) {
        throw new Error(`d-TPP effective date must be an AIRAC edition date: ${options.effectiveDate}`);
    }
    const readCatalog = async (file: string, url: string, expected?: ReturnType<typeof airacCycleForDate>) => {
        // Match Response.text()'s UTF-8 BOM decoding for local and downloaded XML.
        const contents = (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '');
        const catalog = parseProcedureCatalog(contents, url, sha256(contents));
        const edition = expected ?? airacCycleForDate(catalog.effectiveDate);
        if (catalog.cycle !== edition.cycle || catalog.effectiveDate !== edition.effectiveDate ||
            catalog.expirationDate !== edition.expirationDate) {
            throw new Error(
                `d-TPP XML edition mismatch: expected ${edition.cycle} ` +
                `(${edition.effectiveDate} through ${edition.expirationDate}), got ${catalog.cycle} ` +
                `(${catalog.effectiveDate} through ${catalog.expirationDate}): ${url}`
            );
        }
        if (!catalog.airports.length || !catalog.airports.some(airport => airport.procedures.length)) {
            throw new Error(`d-TPP XML has no active procedures: ${url}`);
        }
        return catalog;
    };
    if (options.sourceXml) {
        const filePath = path.resolve(options.sourceXml);
        return readCatalog(filePath, pathToFileURL(filePath).href, requested);
    }

    // The search page can drop the preceding edition before 0901Z. Dated XML
    // remains available; its own header, not the page's "Current" label, is authoritative.
    const edition = requested ?? airacCycleForDate(options.today ?? faaEffectiveDate());
    const url = `${FAA_DTPP_BASE_URL}${edition.cycle}/xml_data/d-tpp_Metafile.xml`;
    const directory = path.resolve(options.output, 'sources', edition.effectiveDate, 'tpp');
    const file = path.join(directory, 'd-tpp_Metafile.xml');
    const release = await acquireChartBuildLock(directory);
    try {
        await downloadFile(url, file, {
            userAgent: 'faa-regs-procedure-builder/1.0', revalidate: true,
            validate: async candidate => { await readCatalog(candidate, url, edition); }
        });
        return await readCatalog(file, url, edition);
    } finally { await release(); }
}

async function findVolumeCandidates(
    outputRoot: string,
    effectiveDate: string,
    catalogDirectory: string,
    requestedVolumes: ReadonlySet<string>
): Promise<VolumeCandidate[]> {
    const candidates = new Map<string, VolumeCandidate>();
    for (const source of await pdfBookSources(outputRoot, effectiveDate)) {
        const name = source.name.match(/^tpp-([a-z0-9]+)\.pdf$/i)?.[1].toUpperCase();
        const id = /^cs-pac\.pdf$/i.test(source.name) ? 'PC1' : name === 'AK' ? 'AK1' : name;
        // A prior change notice never supplies pages for a new edition.
        if (id === 'CN' && source.cycle !== effectiveDate) continue;
        if (id && requestedVolumes.has(id) && !candidates.has(id)) {
            candidates.set(id, { id, ...await publishPdfBook(outputRoot, source, catalogDirectory) });
        }
    }
    return [...candidates.values()];
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
        schemaVersion: 2,
        ...jsonArtifact('catalog.json', catalog),
        builderVersion: PROCEDURE_BUILDER_VERSION,
        cycle: catalog.cycle,
        effectiveDate: catalog.effectiveDate,
        expirationDate: catalog.expirationDate,
        generatedAt: catalog.generatedAt,
        sourceXml: catalog.sourceXml,
        associationStatus: catalog.associations ? 'available' : 'unavailable',
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
    if (existing.builderVersion !== PROCEDURE_BUILDER_VERSION) return false;
    if (existing.effectiveDate !== next.effectiveDate) return false;
    if (existing.volumes.length !== volumes.length) return false;
    const existingVolumes = new Map(existing.volumes.map(volume => [volume.id, volume]));
    return volumes.every(volume => existingVolumes.get(volume.id)?.sha256 === volume.sha256 &&
        existingVolumes.get(volume.id)?.byteLength === volume.byteLength);
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
