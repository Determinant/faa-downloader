import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DOMParser, type Element } from '@xmldom/xmldom';
import { buildFingerprint, readCachedJson, writeCachedJson } from './build-cache.ts';
import { mapWithConcurrency } from './concurrency.ts';
import { sha256File } from './fs-utils.ts';
import { downloadFile } from './http-download.ts';
import type { OfflineRegionDefinition } from './chart-packager.ts';
import { TERRAIN_MAX_ZOOM, terrainGridBounds, terrainRegionBlocks } from './terrain-grid.ts';
import { inspectTerrainRaster, intersects, type TerrainBounds } from './terrain-raster.ts';

export const USGS_TERRAIN_ROOT = 'https://prd-tnm.s3.amazonaws.com/';
export const USGS_TERRAIN_PREFIX = 'StagedProducts/Elevation/1/TIFF/current/';
export const USGS_TERRAIN_SOURCE = 'https://www.usgs.gov/3d-elevation-program';
const USER_AGENT = 'faa-regs-terrain-builder/1.0';
// Raster and XML borders vary by edition; allow a small margin around the named one-degree tile.
const USGS_TILE_BORDER_MARGIN = 1 / 60;
type Logger = Pick<Console, 'log' | 'warn'>;
export type TerrainObject = { key: string; url: string; etag: string; lastModified: string; byteLength: number };
export type TerrainProduct = TerrainObject & { id: string; bounds: TerrainBounds; metadata: TerrainObject };
export type TerrainInput = {
    id: string; url: string; sha256: string; byteLength: number; bounds: TerrainBounds;
    etag?: string; lastModified?: string;
    metadata: { url: string; sha256: string; verticalDatum: string; units: 'metres' };
    file: string;
};

function parseXml(text: string) {
    // USGS FGDC sidecars declare an external DTD. No DTD fetch or entity expansion is needed.
    text = text.replace(/<!DOCTYPE\s+metadata\s+SYSTEM\s+("[^"]*"|'[^']*')\s*>/gi, '');
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('Unexpected XML document type');
    return new DOMParser({ onError: (level, message) => { throw new Error(`Invalid terrain XML: ${message}`); } })
        .parseFromString(text, 'application/xml');
}
const child = (element: Element, name: string) => element.getElementsByTagName(name)[0]?.textContent?.trim();
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function parseTerrainListing(xml: string): { objects: TerrainObject[]; next?: string } {
    const root = parseXml(xml).documentElement;
    if (root.tagName !== 'ListBucketResult' || child(root, 'Prefix') !== USGS_TERRAIN_PREFIX ||
        !['true', 'false'].includes(child(root, 'IsTruncated') ?? '')) throw new Error('Invalid USGS terrain object listing');
    const objects: TerrainObject[] = [];
    for (const element of Array.from(root.getElementsByTagName('Contents'))) {
        const key = child(element, 'Key'), etag = child(element, 'ETag'), date = child(element, 'LastModified');
        const size = child(element, 'Size'), byteLength = Number(size);
        if (!key?.startsWith(USGS_TERRAIN_PREFIX) || !/^"[^"\r\n]+"$/.test(etag ?? '') ||
            !date || !Number.isFinite(Date.parse(date)) || !/^\d+$/.test(size ?? '') || !Number.isSafeInteger(byteLength)) {
            throw new Error('Invalid USGS terrain object metadata');
        }
        if (!/\.(tif|xml)$/i.test(key)) continue;
        if (byteLength <= 0) throw new Error(`Empty USGS terrain object: ${key}`);
        objects.push({ key, url: USGS_TERRAIN_ROOT + key.split('/').map(encodeURIComponent).join('/'),
            etag: etag!, lastModified: new Date(date).toISOString(), byteLength });
    }
    const next = child(root, 'IsTruncated') === 'true' ? child(root, 'NextContinuationToken') : undefined;
    if (child(root, 'IsTruncated') === 'true' && !next) throw new Error('Missing USGS terrain continuation token');
    return { objects, next };
}

async function fetchListing(url: URL, fetcher: typeof fetch): Promise<string> {
    for (let attempt = 0; ; attempt++) {
        try {
            const response = await fetcher(url, { headers: { 'user-agent': USER_AGENT, 'cache-control': 'no-cache' },
                signal: AbortSignal.timeout(60_000) });
            if (!response.ok) {
                await response.body?.cancel();
                throw new Error(`USGS terrain listing failed (${response.status})`);
            }
            const text = await response.text();
            if (text.length > 8 * 1024 * 1024) throw new Error('USGS terrain listing exceeds size bound');
            return text;
        } catch (error) {
            if (attempt === 2) throw error;
            await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
        }
    }
}

/** S3's current directory is the authoritative catalog, including each file's strong version validator. */
export async function discoverTerrainProducts(regions: OfflineRegionDefinition[], fetcher = globalThis.fetch): Promise<TerrainProduct[]> {
    const objects = new Map<string, TerrainObject>(), tokens = new Set<string>();
    let next: string | undefined;
    do {
        const url = new URL(USGS_TERRAIN_ROOT);
        url.search = new URLSearchParams({ 'list-type': '2', prefix: USGS_TERRAIN_PREFIX, 'max-keys': '1000',
            ...(next ? { 'continuation-token': next } : {}) }).toString();
        const page = parseTerrainListing(await fetchListing(url, fetcher));
        for (const object of page.objects) {
            if (objects.has(object.key)) throw new Error(`Duplicate USGS terrain object: ${object.key}; retry catalog discovery`);
            objects.set(object.key, object);
        }
        next = page.next;
        if (next && tokens.has(next)) throw new Error('USGS terrain catalog repeated a continuation token');
        if (next) tokens.add(next);
        if (tokens.size > 1000) throw new Error('USGS terrain catalog exceeds pagination bound');
    } while (next);
    // Download sources covering complete delivery blocks, including their source overlap.
    const envelopes = terrainRegionBlocks(regions, TERRAIN_MAX_ZOOM, TERRAIN_MAX_ZOOM)
        .map(block => terrainGridBounds(block.zoom, block.x, block.y, 2, 1));
    const products: TerrainProduct[] = [];
    for (const object of objects.values()) {
        // The shared listing can contain stray files from other products, including USGS_13_*.
        if (!object.key.endsWith('.tif') || !path.posix.basename(object.key).startsWith('USGS_1_')) continue;
        const match = object.key.slice(USGS_TERRAIN_PREFIX.length).match(/^(([ns])(\d{2})([ew])(\d{3}))\/USGS_1_\1\.tif$/);
        if (!match) throw new Error(`Unrecognized current USGS terrain tile: ${object.key}`);
        const north = Number(match[3]) * (match[2] === 'n' ? 1 : -1);
        const west = Number(match[5]) * (match[4] === 'e' ? 1 : -1);
        if (north <= -90 || north > 90 || west < -180 || west >= 180) throw new Error(`Invalid USGS tile coordinates: ${object.key}`);
        // Border widths vary by tile (including 2, 6 and 12 arc-seconds and clipped edges).
        // This conservative discovery halo is replaced by measured bounds after download.
        const overlap = USGS_TILE_BORDER_MARGIN;
        const bounds: TerrainBounds = [west - overlap, north - 1 - overlap, west + 1 + overlap, north + overlap];
        if (!envelopes.some(envelope => intersects(envelope, bounds))) continue;
        const metadata = objects.get(object.key.replace(/\.tif$/, '.xml'));
        if (!metadata) throw new Error(`Missing USGS terrain metadata for ${object.key}`);
        products.push({ ...object, id: match[1], bounds, metadata });
    }
    if (!products.length) throw new Error('No current USGS 3DEP 1-arc-second terrain covers the selected regions');
    return products.sort((a, b) => a.id.localeCompare(b.id));
}

export function parseTerrainMetadata(xml: string): { verticalDatum: string; units: 'metres' } {
    const root = parseXml(xml).documentElement;
    const verticalDatum = child(root, 'altdatum'), units = child(root, 'altunits');
    if (!verticalDatum || /^(unknown|unspecified|not specified|none|n\/a)$/i.test(verticalDatum) ||
        !/^m(eters?|etres?)?$/i.test(units ?? '')) {
        throw new Error('USGS terrain metadata must declare a vertical datum and elevations in metres');
    }
    if (/ellipsoid/i.test(verticalDatum)) throw new Error('Ellipsoidal heights are not supported as terrain MSL elevations');
    return { verticalDatum, units: 'metres' };
}

function parseTerrainMetadataBounds(xml: string): TerrainBounds {
    const bounding = parseXml(xml).documentElement.getElementsByTagName('bounding')[0];
    const values = ['westbc', 'southbc', 'eastbc', 'northbc'].map(name => bounding && child(bounding, name));
    const bounds = values.map(Number) as TerrainBounds;
    if (values.some(value => !value) || !bounds.every(Number.isFinite) ||
        bounds[0] >= bounds[2] || bounds[1] >= bounds[3] ||
        bounds[0] < -181 || bounds[2] > 181 || bounds[1] < -90 || bounds[3] > 90) {
        throw new Error('USGS terrain metadata must declare a valid geographic footprint');
    }
    return bounds;
}

function footprintMatchesTile(bounds: TerrainBounds, product: TerrainProduct): boolean {
    return bounds.every((n, i) => Math.abs(n - Math.round(product.bounds[i])) <= USGS_TILE_BORDER_MARGIN);
}

async function cachedObject(object: TerrainObject, cache: string, extension: string,
    validate: (file: string) => Promise<void>, fetcher: typeof fetch, logger: Logger) {
    // ETags are opaque validators, including multipart S3 ETags; they are not local checksums.
    const identity = buildFingerprint({ url: object.url, etag: object.etag, byteLength: object.byteLength });
    const file = path.join(cache, 'objects', `${identity}.${extension}`), metadata = `${file}.json`, receipt = `${file}.build.json`;
    const saved = await readCachedJson<{ sha256: string }>(metadata, receipt, identity);
    if (saved && isHash(saved.sha256) && await fs.stat(file).then(stat => stat.size === object.byteLength).catch(error => {
        if (error.code !== 'ENOENT') throw error; return false;
    }) && await sha256File(file) === saved.sha256) {
        // Recover measured bounds and apply current validation to reused files too.
        await validate(file);
        return { file, sha256: saved.sha256, reused: true };
    }
    await fs.rm(file, { force: true });
    await downloadFile(object.url, file, {
        userAgent: USER_AGENT, logger,
        // An interrupted transfer remains attached to this exact object version, even across runs.
        fetch: async (url, init) => {
            const headers = new Headers(init?.headers);
            headers.set('if-match', object.etag); headers.set('cache-control', 'no-cache');
            const response = await fetcher(url, { ...init, headers });
            if (response.ok && response.headers.get('etag') !== object.etag) {
                await response.body?.cancel(); throw new Error(`USGS terrain version changed while downloading ${object.url}`);
            }
            return response;
        },
        validate: async candidate => {
            if ((await fs.stat(candidate)).size !== object.byteLength) throw new Error(`Incomplete USGS terrain object: ${object.url}`);
            await validate(candidate);
        }
    });
    const sha256 = await sha256File(file);
    await writeCachedJson(metadata, receipt, identity, { sha256 });
    return { file, sha256, reused: false };
}

export async function loadTerrainInputs(regions: OfflineRegionDefinition[], cache: string, options: {
    sourceDirectory?: string; fetch?: typeof globalThis.fetch; logger?: Logger;
} = {}): Promise<TerrainInput[]> {
    const logger = options.logger ?? console;
    if (options.sourceDirectory) {
        const directory = path.resolve(options.sourceDirectory);
        const names = (await fs.readdir(directory)).filter(name => /\.tiff?$/i.test(name)).sort();
        if (!names.length) throw new Error('Local terrain directory contains no GeoTIFFs');
        return mapWithConcurrency(names, 4, async name => {
            const original = path.join(directory, name), sha256 = await sha256File(original);
            const file = path.join(cache, 'local', `${sha256}.tif`);
            await fs.mkdir(path.dirname(file), { recursive: true });
            if (await sha256File(file).catch(error => { if (error.code !== 'ENOENT') throw error; return ''; }) !== sha256) {
                const work = await fs.mkdtemp(path.join(cache, '.import-'));
                try {
                    const temporary = path.join(work, 'source.tif');
                    await fs.copyFile(original, temporary);
                    if (await sha256File(temporary) !== sha256) throw new Error(`Local terrain changed during import: ${name}`);
                    await fs.rename(temporary, file);
                } finally { await fs.rm(work, { recursive: true, force: true }); }
            }
            const bounds = await inspectTerrainRaster(file);
            const xml = await fs.readFile(original.replace(/\.tiff?$/i, '.xml'), 'utf8');
            return { id: name, url: `local:${name}`, sha256, file, bounds, byteLength: (await fs.stat(file)).size,
                metadata: { url: `local:${name.replace(/\.tiff?$/i, '.xml')}`,
                    sha256: createHash('sha256').update(xml).digest('hex'), ...parseTerrainMetadata(xml) } };
        });
    }
    const fetcher = options.fetch ?? globalThis.fetch;
    const products = await discoverTerrainProducts(regions, fetcher);
    logger.log(`USGS terrain: checking ${products.length} current 1-arc-second GeoTIFFs against the local cache ` +
        `(${(products.reduce((total, p) => total + p.byteLength, 0) / 1024 ** 3).toFixed(1)} GiB of source files)`);
    let reused = 0, checked = 0;
    const inputs = await mapWithConcurrency(products, 4, async product => {
        if (product.metadata.byteLength > 4 * 1024 * 1024) throw new Error('USGS terrain metadata exceeds size bound');
        const metadata = await cachedObject(product.metadata, cache, 'xml', async file => {
            const xml = await fs.readFile(file, 'utf8');
            parseTerrainMetadata(xml); parseTerrainMetadataBounds(xml);
        }, fetcher, logger);
        const xml = await fs.readFile(metadata.file, 'utf8');
        const datum = parseTerrainMetadata(xml), declaredBounds = parseTerrainMetadataBounds(xml);
        if (!footprintMatchesTile(declaredBounds, product)) {
            throw new Error(`USGS metadata footprint disagrees with its tile identifier: ${product.id}`);
        }
        let bounds: TerrainBounds;
        const raster = await cachedObject(product, cache, 'tif', async file => {
            bounds = await inspectTerrainRaster(file);
            // Some sidecars retain wider legacy borders. The raster is authoritative for coverage.
            if (!footprintMatchesTile(bounds, product)) {
                throw new Error(`USGS raster footprint disagrees with its tile identifier: ${product.id}`);
            }
        }, fetcher, logger);
        if (raster.reused) reused++;
        checked++;
        if (checked % 100 === 0 || checked === products.length) {
            logger.log(`USGS terrain: ${checked}/${products.length} source tiles checked (${reused} reused)`);
        }
        return { id: product.id, url: product.url, etag: product.etag, lastModified: product.lastModified,
            byteLength: product.byteLength, bounds, file: raster.file, sha256: raster.sha256,
            metadata: { url: product.metadata.url, sha256: metadata.sha256, ...datum } };
    });
    logger.log(`USGS terrain: ${reused} GeoTIFFs unchanged; ${products.length - reused} downloaded`);
    return inputs;
}
