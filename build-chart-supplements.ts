#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getDocument, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { sha256File, writeFileAtomic, toPosixPath } from './lib/fs-utils.ts';
import { buildFingerprint, readCachedJson, writeCachedJson } from './lib/build-cache.ts';
import { parseVolumeEffectiveInterval } from './lib/procedures.ts';
import {
    parseSupplementIndex, supplementDate, supplementDateCode, supplementPageLabel,
    SUPPLEMENT_BUILDER_VERSION, SUPPLEMENT_REGIONS, type SupplementCatalog, type SupplementVolume,
} from './lib/chart-supplements.ts';

type Options = { output: string; effectiveDate?: string; sourceXml?: string; force?: boolean };

/** Index the original regional books; no PDF splitting, rewriting, or browser scanning. */
export async function buildChartSupplements(options: Options): Promise<SupplementCatalog> {
    const chartsRoot = path.resolve(options.output, 'charts');
    const today = new Date().toISOString().slice(0, 10);
    const cycles = (await fs.readdir(chartsRoot, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
        .map(entry => entry.name).sort().reverse();
    const revision = supplementDate(options.effectiveDate ?? cycles.find(cycle => cycle <= today) ?? today);
    const directory = path.join(chartsRoot, revision, 'cs');
    const catalogFile = path.join(directory, 'catalog.json');
    const receiptFile = path.resolve(options.output, 'supplements', `${revision}.build.json`);
    const catalog: SupplementCatalog = {
        schemaVersion: 2, builderVersion: SUPPLEMENT_BUILDER_VERSION,
        effectiveDate: '', expirationDate: '', generatedAt: new Date().toISOString(),
        sourceXml: { url: '', sha256: '' }, volumes: [], airports: [], expected: [],
    };
    const volumes: Array<Omit<SupplementVolume, 'pageCount'> & { file: string }> = [];
    for (const region of SUPPLEMENT_REGIONS) {
        let file: string | undefined;
        for (const cycle of cycles.filter(cycle => cycle <= revision)) {
            const candidate = path.join(chartsRoot, cycle, `cs-${region.toLowerCase()}.pdf`);
            try { await fs.access(candidate); file = candidate; break; }
            catch (error: any) { if (error.code !== 'ENOENT') throw error; }
        }
        if (!file) continue; // A partial regional build is valid.
        volumes.push({ id: region, file, url: toPosixPath(path.relative(directory, file)),
            byteLength: (await fs.stat(file)).size, sha256: await sha256File(file) });
    }
    let index: ReturnType<typeof parseSupplementIndex> | undefined;
    let inputSha256: string;
    for (const { file, ...volume } of volumes) {
        const region = volume.id;
        const task = getDocument({ url: file, verbosity: VerbosityLevel.ERRORS, useSystemFonts: true });
        try {
            const pdf = await task.promise;
            const cover = await pdf.getPage(1);
            const text = (await cover.getTextContent()).items.map(item => 'str' in item ? item.str : '').join(' ');
            const interval = parseVolumeEffectiveInterval(text);
            if (!interval || revision < interval.effectiveDate || revision >= interval.expirationDate) {
                throw new Error(`${region}: Chart Supplement does not cover ${revision}`);
            }
            if (!index) {
                const code = supplementDateCode(interval.effectiveDate);
                const url = `https://aeronav.faa.gov/afd/${code}/afd_${code}.xml`;
                const xml = await loadIndex(options, code, url);
                index = parseSupplementIndex(xml.toString('latin1'));
                catalog.effectiveDate = index.effectiveDate;
                catalog.expirationDate = index.expirationDate;
                catalog.sourceXml = { url, sha256: createHash('sha256').update(xml).digest('hex') };
                catalog.expected = index.airports.map(({ faaId, state, volumeId, printedPage }) => ({ faaId, state, volumeId, printedPage }));
                inputSha256 = buildFingerprint({
                    schemaVersion: catalog.schemaVersion, builderVersion: SUPPLEMENT_BUILDER_VERSION,
                    revision, sourceXml: catalog.sourceXml,
                    volumes: volumes.map(({ file: _file, ...identity }) => identity)
                });
            }
            if (index.effectiveDate !== interval.effectiveDate || index.expirationDate !== interval.expirationDate) {
                throw new Error(`${region}: Chart Supplement PDF and XML editions differ`);
            }
            if (!options.force && catalog.volumes.length === 0) {
                const existing = await readCachedJson<SupplementCatalog>(catalogFile, receiptFile, inputSha256);
                if (existing) {
                    console.log(`Chart Supplement catalog for ${revision} is already current`);
                    return existing;
                }
            }
            console.log(`indexing Chart Supplement ${region}`);
            // Restrict labels to the directory section; Pacific restarts numbering in TPP.
            const outline = await pdf.getOutline();
            const sectionStart = async (number: number) => {
                const entry = outline?.find(item => item.title.startsWith(`SECTION ${number}:`));
                const destination = typeof entry?.dest === 'string' ? await pdf.getDestination(entry.dest) : entry?.dest;
                if (!destination) throw new Error(`${region}: missing directory section ${number}`);
                return typeof destination[0] === 'number' ? destination[0] : pdf.getPageIndex(destination[0]);
            };
            const start = await sectionStart(2);
            const end = await sectionStart(3);
            if (end <= start) throw new Error(`${region}: invalid directory section bounds`);
            const pages = new Map<string, number>();
            for (let pageIndex = start; pageIndex < end; pageIndex++) {
                const page = await pdf.getPage(pageIndex + 1);
                const content = await page.getTextContent();
                const items = content.items.flatMap(item => 'str' in item
                    ? [{ text: item.str, x: item.transform[4], y: item.transform[5], width: item.width }] : []);
                const label = supplementPageLabel(items, page.view[2] - page.view[0], page.view[3] - page.view[1]);
                if (label) {
                    if (pages.has(label)) throw new Error(`${region}: ambiguous printed page ${label}`);
                    pages.set(label, pageIndex);
                }
                page.cleanup();
            }
            for (const airport of index.airports.filter(airport => airport.volumeId === region)) {
                const pageIndex = pages.get(airport.printedPage);
                if (pageIndex === undefined) throw new Error(`${region}: missing page ${airport.printedPage} for ${airport.faaId}`);
                catalog.airports.push({ ...airport, pageIndex });
            }
            if (await sha256File(file) !== volume.sha256) throw new Error(`${region}: PDF changed while indexing`);
            catalog.volumes.push({ ...volume, pageCount: pdf.numPages });
        } finally { await task.destroy(); }
    }
    if (!catalog.volumes.length || !catalog.airports.length) throw new Error(`No Chart Supplements available for ${revision}`);
    catalog.airports.sort((a, b) => a.faaId.localeCompare(b.faaId) || a.volumeId.localeCompare(b.volumeId));
    await fs.mkdir(directory, { recursive: true });
    // One small, atomically replaced catalog is the entire metadata publication.
    await writeCachedJson(catalogFile, receiptFile, inputSha256, catalog);
    console.log(`Wrote ${catalog.airports.length} airport entries in ${catalog.volumes.length} books to ${directory}`);
    return catalog;
}

async function loadIndex(options: Options, code: string, url: string): Promise<Buffer> {
    if (options.sourceXml) return fs.readFile(options.sourceXml);
    const file = path.resolve(options.output, 'supplements', `afd_${code}.xml`);
    try { return await fs.readFile(file); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`FAA Chart Supplement index: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    parseSupplementIndex(bytes.toString('latin1'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, bytes);
    return bytes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const options: Options = { output: 'dist' };
    for (const arg of process.argv.slice(2)) {
        if (arg.startsWith('--output=')) options.output = arg.slice(9);
        else if (arg.startsWith('--effective-date=')) options.effectiveDate = supplementDate(arg.slice(17));
        else if (arg.startsWith('--source-xml=')) options.sourceXml = arg.slice(13);
        else if (arg === '--force') options.force = true;
        else if (arg === '--help' || arg === '-h') {
            console.log('Usage: npm run build:supplements -- [--output=dist] [--effective-date=YYYY-MM-DD] [--source-xml=PATH] [--force]\n' +
                'Index existing regional books into DIR/charts/YYYY-MM-DD/cs/; does not download PDFs.\n' +
                'Uses cached/downloaded XML unless --source-xml is provided. Reuses verified catalogs unless --force is supplied.');
            process.exit(0);
        }
        else throw new Error(`Unknown argument: ${arg}`);
    }
    if (!options.output.trim() || options.sourceXml === '') throw new Error('Paths must not be empty');
    await buildChartSupplements(options);
}
