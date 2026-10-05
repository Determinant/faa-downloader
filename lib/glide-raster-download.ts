import fs from 'node:fs/promises';
import path from 'node:path';
import type { Element } from '@xmldom/xmldom';
import { buildFingerprint } from './build-cache.ts';
import { downloadFile, DownloadHttpError } from './http-download.ts';
import { InvalidDownloadError } from './download-validation.ts';
import { gdalCommand } from './gdal.ts';
import { parseTerrainMetadata } from './terrain-source.ts';
import { inspectGlideRaster } from './glide-sources.ts';
import { cachedGlideSource, readGlideSource, glideFetchText, glideXml, xmlElements } from './glide-download.ts';
import { containsBounds } from './glide-model.ts';
import type { Bounds, ResolvedAsset } from './glide-model.ts';

const USGS_ROOT = 'https://prd-tnm.s3.amazonaws.com/';
const DEM_PREFIX = 'StagedProducts/Elevation/13/TIFF/current/';
export const GLIDE_COVER_SERVICES = {
    landcover: 'Land-Cover', impervious: 'Fractional-Impervious-Surface',
    shrubCover: 'RCMAP shrub cover', shrubHeight: 'RCMAP mean shrub height', shrubTreeCover: 'RCMAP tree cover'
} as const;
export type CoverRole = keyof typeof GLIDE_COVER_SERVICES;
export type CoverService = { endpoint: string; coverage: string; time: string; revision: string;
    srs: string; origin: [number, number]; spacing: [number, number]; extent: Bounds };
const text = (root: Element, name: string) => xmlElements(root, name)[0]?.textContent?.trim();
const pair = (value?: string): [number, number] => (value?.trim().split(/\s+/).map(Number) ?? []) as [number, number];

export function parseGlideCoverage(xml: string, endpoint: string, expectedSrs = 'EPSG:5070'): CoverService {
    const root = glideXml(xml), offering = xmlElements(root, 'CoverageOffering')[0];
    const grid = offering && xmlElements(offering, 'RectifiedGrid')[0];
    const temporal = offering && xmlElements(offering, 'temporalDomain')[0];
    const times = temporal && xmlElements(temporal, 'timePosition').map(node => node.textContent!.trim()).sort();
    const coverage = offering && text(offering, 'name'), origin = grid && pair(text(xmlElements(grid, 'origin')[0], 'pos'));
    const vectors = grid && xmlElements(grid, 'offsetVector').map(node => pair(node.textContent!));
    const low = grid && pair(text(grid, 'low')), high = grid && pair(text(grid, 'high'));
    const srs = grid?.getAttribute('srsName');
    if (!coverage || srs !== expectedSrs || !['EPSG:5070', 'EPSG:3857'].includes(expectedSrs) || !times?.length ||
        times.some(time => !/^\d{4}-01-01T00:00:00(?:\.000)?Z$/.test(time)) ||
        !origin || origin.length !== 2 || !origin.every(Number.isFinite) || vectors?.length !== 2 ||
        low?.length !== 2 || low.some(value => value !== 0) || high?.length !== 2 ||
        high.some(value => !Number.isSafeInteger(value) || value < 0) ||
        vectors[0][0] !== 30 || vectors[0][1] !== 0 || vectors[1][0] !== 0 || vectors[1][1] !== -30) {
        throw new Error('Unsupported MRLC native grid; refusing to resample cover during acquisition');
    }
    // Grid indices are inclusive and origin is the centre of pixel (0, 0).
    const extent: Bounds = [origin[0] - 15, origin[1] - (high[1] + 0.5) * 30,
        origin[0] + (high[0] + 0.5) * 30, origin[1] + 15];
    return { endpoint, coverage, time: times.at(-1)!, revision: buildFingerprint(xml), srs, origin, spacing: [30, -30], extent };
}

export async function discoverGlideCover(): Promise<Record<'landcover' | 'impervious', CoverService>> {
    const result = {} as Record<'landcover' | 'impervious', CoverService>;
    for (const role of ['landcover', 'impervious'] as const) {
        const title = GLIDE_COVER_SERVICES[role];
        const coverage = `mrlc_${title}-Native_conus_year_data:${title}-Native_conus_year_data`;
        const endpoint = `https://dmsdata.cr.usgs.gov/geoserver/mrlc_${title}-Native_conus_year_data/wcs`;
        const url = new URL(endpoint);
        url.search = new URLSearchParams({ service: 'WCS', version: '1.0.0', request: 'DescribeCoverage', coverage }).toString();
        result[role] = parseGlideCoverage(await glideFetchText(url.href), endpoint);
    }
    return result;
}

/** Densify geographic edges, project, and expand to the original pixel boundaries. */
export async function glideNativeWindow(bounds: Bounds, service: Pick<CoverService, 'srs' | 'origin' | 'spacing'>, cache: string): Promise<Bounds> {
    const work = await fs.mkdtemp(path.join(cache, '.window-'));
    try {
        const [w, s, e, n] = bounds, coordinates: number[][] = [];
        const corners = [[w, s], [e, s], [e, n], [w, n], [w, s]];
        for (let edge = 0; edge < 4; edge++) for (let step = 0; step < 32; step++) {
            coordinates.push(corners[edge].map((v, axis) => v + (corners[edge + 1][axis] - v) * step / 32));
        }
        coordinates.push(corners[0]);
        const input = path.join(work, 'bounds.json'), output = path.join(work, 'projected.json');
        await fs.writeFile(input, JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {},
            geometry: { type: 'Polygon', coordinates: [coordinates] } }] }));
        await gdalCommand('ogr2ogr', ['-f', 'GeoJSON', '-t_srs', service.srs, output, input]);
        const points: number[][] = JSON.parse(await fs.readFile(output, 'utf8')).features[0].geometry.coordinates[0];
        const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
        const step = service.spacing[0];
        const ox = service.origin[0] - step / 2, oy = service.origin[1] + step / 2;
        return [ox + Math.floor((Math.min(...xs) - ox) / step) * step - step,
            oy + Math.floor((Math.min(...ys) - oy) / step) * step - step,
            ox + Math.ceil((Math.max(...xs) - ox) / step) * step + step,
            oy + Math.ceil((Math.max(...ys) - oy) / step) * step + step];
    } finally { await fs.rm(work, { recursive: true, force: true }); }
}

function coverWindow(window: Bounds, extent: Bounds): Bounds | undefined {
    const clipped: Bounds = [Math.max(window[0], extent[0]), Math.max(window[1], extent[1]),
        Math.min(window[2], extent[2]), Math.min(window[3], extent[3])];
    return clipped[0] < clipped[2] && clipped[1] < clipped[3] ? clipped : undefined;
}

async function validateCoverResponse(file: string, role: CoverRole): Promise<void> {
    const handle = await fs.open(file, 'r');
    let prefix: Buffer;
    try {
        const buffer = Buffer.alloc(2048);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        prefix = buffer.subarray(0, bytesRead);
    } finally { await handle.close(); }
    // GeoServer can return an XML service exception with HTTP 200. Do not pass
    // these bytes to GDAL, or mistake a service failure for an empty raster.
    const signature = prefix.subarray(0, 4).toString('hex');
    if (!['49492a00', '4d4d002a', '49492b00', '4d4d002b'].includes(signature)) {
        const detail = prefix.toString('utf8').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
        throw new InvalidDownloadError(`MRLC ${role} returned a non-TIFF response: ${detail || 'empty response'}`);
    }
    await inspectGlideRaster(file, role);
}

/** Undefined means outside the published grid, never a failed request. */
export async function downloadGlideCover(role: CoverRole, service: CoverService, bounds: Bounds,
    cache: string, refresh = false, previousBounds?: Bounds): Promise<ResolvedAsset | undefined> {
    const window = coverWindow(await glideNativeWindow(bounds, service, cache), service.extent);
    if (!window) return;
    const url = new URL(service.endpoint);
    // Extent is derived from the already-hashed metadata. Keep the original
    // identity for in-bounds windows so interrupted builds retain their caches.
    const { extent, ...identity } = service;
    const inputs = { builder: 1, service: identity, window };
    if (!refresh) {
        const exact = await readGlideSource(cache, inputs, 'tif');
        if (exact) return exact;
        if (previousBounds && containsBounds(previousBounds, bounds)) {
            const previousWindow = coverWindow(await glideNativeWindow(previousBounds, service, cache), extent);
            const previous = previousWindow && await readGlideSource(cache, { builder: 1, service: identity, window: previousWindow }, 'tif');
            if (previous) return previous;
        }
    }
    url.search = new URLSearchParams({ service: 'WCS', version: '1.0.0', request: 'GetCoverage',
        coverage: service.coverage, time: service.time, bbox: window.join(','), crs: service.srs,
        response_crs: service.srs, resx: '30', resy: '30', interpolation: 'nearest neighbor', format: 'GeoTIFF' }).toString();
    return cachedGlideSource(cache, inputs, {
        name: `${GLIDE_COVER_SERVICES[role]} ${service.time.slice(0, 4)} (${role.startsWith('shrub') ? 'published' : 'native'} 30 m subset)`,
        date: service.time.slice(0, 10), url: url.href, revision: service.revision,
        attribution: role.startsWith('shrub') ? 'USGS RCMAP / MRLC; public domain' : 'USGS Annual NLCD / MRLC; public domain'
    }, 'tif', async file => {
        for (let attempt = 1; ; attempt++) {
            try {
                await downloadFile(url.href, file, { userAgent: 'faa-downloader/build-glide',
                    metadataFile: path.join(cache, 'http', `${buildFingerprint(url.href)}.json`),
                    validate: async candidate => {
                        await validateCoverResponse(candidate, role);
                        if (role.startsWith('shrub')) {
                            const info = JSON.parse(await gdalCommand('gdalinfo', ['-json', '-noct', '-norat', candidate]));
                            const expected = [window[0], 30, 0, window[3], 0, -30];
                            if (info.stac?.['proj:epsg'] !== 3857 ||
                                info.size?.[0] !== Math.round((window[2] - window[0]) / 30) ||
                                info.size?.[1] !== Math.round((window[3] - window[1]) / 30) ||
                                info.bands?.[0]?.type !== (role === 'shrubHeight' ? 'UInt16' : 'Byte') ||
                                info.bands?.[0]?.noDataValue !== (role === 'shrubHeight' ? 501 : 101) ||
                                !info.geoTransform?.every((value: number, i: number) => Math.abs(value - expected[i]) < 1e-6)) {
                                throw new Error(`RCMAP ${role} changed published pixel alignment, units/encoding or NoData`);
                            }
                        }
                    } });
                return;
            } catch (error) {
                // A catalog-advertised GeoServer coverage can transiently return
                // 404 while generating a subset. Retry this service only; never
                // interpret a failed request as absent vegetation or clear ground.
                const missingResponse = error instanceof DownloadHttpError && error.status === 404;
                if ((!missingResponse && !(error instanceof InvalidDownloadError)) || attempt === 3) throw error;
                const delay = missingResponse ? 5000 * 2 ** (attempt - 1) : attempt * 500;
                console.warn(`${error.message}; retrying MRLC response in ${delay / 1000}s (${attempt}/3)`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }, refresh);
}

type DemObject = { url: string; etag: string; date: string; bytes: number };
type DemTile = { raster: DemObject; metadata: DemObject };

/** Retain a single catalog promise per degree tile during a build. No national DEM download. */
export class GlideElevationDownloader {
    private readonly tiles = new Map<string, Promise<DemTile | undefined>>();
    private readonly metadata = new Map<string, Promise<void>>();
    constructor(private readonly downloadCommand: typeof gdalCommand = gdalCommand) {}
    private tile(id: string): Promise<DemTile | undefined> {
        if (!this.tiles.has(id)) this.tiles.set(id, (async () => {
            const prefix = `${DEM_PREFIX}${id}/`, url = new URL(USGS_ROOT);
            url.search = new URLSearchParams({ 'list-type': '2', prefix, 'max-keys': '1000' }).toString();
            const root = glideXml(await glideFetchText(url.href));
            if (text(root, 'Prefix') !== prefix || text(root, 'IsTruncated') !== 'false') throw new Error('Incomplete USGS DEM listing');
            const objects = new Map<string, DemObject>();
            for (const object of xmlElements(root, 'Contents')) {
                const key = text(object, 'Key'), etag = text(object, 'ETag'), date = text(object, 'LastModified'), bytes = Number(text(object, 'Size'));
                if (!key?.startsWith(prefix) || !/^"[^"\r\n]+"$/.test(etag ?? '') || !Number.isFinite(Date.parse(date)) || !Number.isSafeInteger(bytes) || bytes <= 0) {
                    throw new Error('Invalid USGS DEM object identity');
                }
                objects.set(path.posix.basename(key), { url: USGS_ROOT + key, etag, date, bytes });
            }
            const raster = objects.get(`USGS_13_${id}.tif`), metadata = objects.get(`USGS_13_${id}.xml`);
            if (!raster) return;
            if (!metadata) throw new Error(`USGS DEM vertical metadata missing for ${id}`);
            return { raster, metadata };
        })());
        return this.tiles.get(id)!;
    }

    async download(bounds: Bounds, cache: string, refresh = false, previousBounds?: Bounds): Promise<ResolvedAsset[]> {
        const assets: ResolvedAsset[] = [];
        for (let south = Math.floor(bounds[1]); south < Math.ceil(bounds[3]); south++) {
            for (let west = Math.floor(bounds[0]); west < Math.ceil(bounds[2]); west++) {
                const id = `n${String(south + 1).padStart(2, '0')}w${String(-west).padStart(3, '0')}`;
                const tile = await this.tile(id);
                if (!tile) continue; // Uncovered source pixels stay unknown, never clear.
                const window: Bounds = [Math.max(bounds[0], west), Math.max(bounds[1], south), Math.min(bounds[2], west + 1), Math.min(bounds[3], south + 1)];
                if (!refresh && previousBounds && containsBounds(previousBounds, bounds)) {
                    const previousWindow = [Math.max(previousBounds[0], west), Math.max(previousBounds[1], south),
                        Math.min(previousBounds[2], west + 1), Math.min(previousBounds[3], south + 1)];
                    const previous = await readGlideSource(cache, { builder: 1, tile, window: previousWindow }, 'tif');
                    if (previous) { assets.push(previous); continue; }
                }
                assets.push(await cachedGlideSource(cache, { builder: 1, tile, window }, {
                    name: `USGS 3DEP 1/3-arc-second ${id}`, date: tile.raster.date.slice(0, 10),
                    url: tile.raster.url, revision: `${tile.raster.etag}; XML ${tile.metadata.etag}`,
                    attribution: 'USGS 3DEP; public domain'
                }, 'tif', async file => {
                    const metadataKey = `${tile.metadata.url}:${tile.metadata.etag}`;
                    if (!this.metadata.has(metadataKey)) this.metadata.set(metadataKey,
                        glideFetchText(tile.metadata.url).then(xml => { parseTerrainMetadata(xml); }));
                    await this.metadata.get(metadataKey);
                    // Range reads preserve original pixels. If-Match prevents a source
                    // revision from changing halfway through GDAL's independent requests.
                    await this.downloadCommand('gdal_translate', ['--config', 'GDAL_DISABLE_READDIR_ON_OPEN', 'EMPTY_DIR',
                        '--config', 'GDAL_HTTP_HEADERS', `If-Match: ${tile.raster.etag}`,
                        '--config', 'GDAL_HTTP_CONNECTTIMEOUT', '30', '--config', 'GDAL_HTTP_TIMEOUT', '120',
                        '--config', 'GDAL_HTTP_MAX_RETRY', '3', '-q', '-of', 'GTiff', '-ovr', 'NONE',
                        '-projwin_srs', 'EPSG:4326', '-projwin', String(window[0]), String(window[3]), String(window[2]), String(window[1]),
                        '-co', 'COMPRESS=DEFLATE', '-co', 'TILED=YES', `/vsicurl/${tile.raster.url}`, file]);
                    await inspectGlideRaster(file, 'elevation');
                }, refresh));
            }
        }
        return assets;
    }
}
