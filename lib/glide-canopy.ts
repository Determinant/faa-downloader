import { buildFingerprint } from './build-cache.ts';
import { cachedGlideSource, glideFetchText } from './glide-download.ts';
import { downloadFile } from './http-download.ts';
import { glideNativeWindow } from './glide-raster-download.ts';
import { inspectGlideRaster } from './glide-sources.ts';
import { gdalCommand } from './gdal.ts';
import type { Bounds, ResolvedAsset } from './glide-model.ts';

// Science TCC retains estimates on agricultural land. Processed NLCD TCC
// masks pasture/cropland to zero and cannot screen trees in those fields.
const ENDPOINT = 'https://imagery.geoplatform.gov/iipp/rest/services/Vegetation/USFS_EDW_Science_TCC_CONUS/ImageServer';
export type GlideCanopyService = { id: number; year: number; revision: string;
    srs: string; origin: [number, number]; spacing: [number, number] };

function latestCanopy(catalog: any) {
    const entries = catalog?.features?.map((feature: any) => feature.attributes);
    if (catalog?.exceededTransferLimit || !entries?.length || entries.some((entry: any) =>
        !Number.isSafeInteger(entry.objectid) || entry.category !== 1 ||
        !Number.isInteger(entry.beginyear) || entry.endyear !== entry.beginyear ||
        !/^science_tcc_conus_/i.test(entry.name ?? ''))) {
        throw new Error('Incomplete USFS Science tree-canopy catalog');
    }
    entries.sort((a: any, b: any) => b.beginyear - a.beginyear);
    const latest = entries[0];
    if (entries[1]?.beginyear === latest.beginyear || latest.beginyear < 2023 || latest.beginyear > new Date().getUTCFullYear()) {
        throw new Error('Expected a unique annual USFS Science tree-canopy raster');
    }
    return latest;
}

export function parseGlideCanopyService(catalog: any, info: any): GlideCanopyService {
    const latest = latestCanopy(catalog), extent = info?.extent;
    // Inspect the locked raster, not the service's Web Mercator display grid.
    if (info?.pixelSizeX !== 30 || info?.pixelSizeY !== 30 || info?.bandCount !== 1 || info?.pixelType !== 'U16' ||
        (extent?.spatialReference?.latestWkid ?? extent?.spatialReference?.wkid) !== 102008 ||
        ![extent?.xmin, extent?.ymin, extent?.xmax, extent?.ymax].every(Number.isFinite) ||
        extent.xmin >= extent.xmax || extent.ymin >= extent.ymax) {
        throw new Error('Expected USFS Science tree canopy on its original 30 m Albers grid');
    }
    return { id: latest.objectid, year: latest.beginyear, revision: buildFingerprint({ latest, info }),
        srs: 'ESRI:102008', origin: [extent.xmin + 15, extent.ymax - 15], spacing: [30, -30] };
}

export async function discoverGlideCanopy(): Promise<GlideCanopyService> {
    const query = new URL(`${ENDPOINT}/query`);
    query.search = new URLSearchParams({ f: 'json', where: 'category=1',
        outFields: 'objectid,name,beginyear,endyear,category,resolution', returnGeometry: 'false' }).toString();
    const catalog = JSON.parse(await glideFetchText(query.href));
    const id = latestCanopy(catalog).objectid;
    return parseGlideCanopyService(catalog, JSON.parse(await glideFetchText(`${ENDPOINT}/${id}/info?f=json`)));
}

/** Existing numeric estimates only: no photographs, CV or national raster download. */
export async function downloadGlideCanopy(service: GlideCanopyService, bounds: Bounds,
    cache: string, refresh = false): Promise<ResolvedAsset[]> {
    const window = await glideNativeWindow(bounds, service, cache), assets: ResolvedAsset[] = [];
    const span = 4096 * 30;
    for (let north = window[3]; north > window[1]; north -= span) {
        for (let west = window[0]; west < window[2]; west += span) {
            const east = Math.min(west + span, window[2]), south = Math.max(north - span, window[1]);
            const width = Math.round((east - west) / 30), height = Math.round((north - south) / 30);
            const url = new URL(`${ENDPOINT}/exportImage`);
            url.search = new URLSearchParams({ f: 'image', bbox: [west, south, east, north].join(','),
                bboxSR: '102008', imageSR: '102008', size: `${width},${height}`, format: 'tiff',
                pixelType: 'U16', interpolation: 'RSP_NearestNeighbor', compression: 'LZ77',
                noData: '255', adjustAspectRatio: 'false', renderingRule: JSON.stringify({ rasterFunction: 'None' }),
                mosaicRule: JSON.stringify({ mosaicMethod: 'esriMosaicLockRaster', lockRasterIds: [service.id],
                    mosaicOperation: 'MT_FIRST' }) }).toString();
            assets.push(await cachedGlideSource(cache, { kind: 'science-tcc-v1', service, url: url.href }, {
                name: `USFS Science TCC ${service.year} (unmasked 30 m subset)`, date: `${service.year}-12-31`,
                url: url.href, revision: service.revision, attribution: 'USDA Forest Service Science Tree Canopy Cover; public domain'
            }, 'tif', file => downloadFile(url.href, file, { userAgent: 'faa-downloader/build-glide',
                validate: async candidate => {
                    await inspectGlideRaster(candidate, 'canopy');
                    const info = JSON.parse(await gdalCommand('gdalinfo', ['-json', '-noct', '-norat', candidate]));
                    // GeoTIFF omits the ESRI authority id; verify the actual
                    // NAD83 Albers definition, not a display name or assumed CRS.
                    const crs = info.stac?.['proj:projjson'], conversion = crs?.conversion;
                    const expected = [[8821, 40], [8822, -96], [8823, 20], [8824, 60], [8826, 0], [8827, 0]];
                    const nativeCrs = crs?.base_crs?.id?.authority === 'EPSG' && crs.base_crs.id.code === 4269 &&
                        conversion?.method?.id?.authority === 'EPSG' && conversion.method.id.code === 9822 &&
                        conversion.parameters?.length === expected.length && expected.every(([code, value]) =>
                            conversion.parameters.some((p: any) => p.id?.authority === 'EPSG' && p.id.code === code &&
                                p.value === value && p.unit === (code < 8826 ? 'degree' : 'metre')));
                    if (!nativeCrs || info.size?.[0] !== width || info.size?.[1] !== height ||
                        info.bands?.[0]?.type !== 'UInt16' || info.bands?.[0]?.noDataValue !== 255 ||
                        !info.geoTransform?.every((value: number, i: number) =>
                            Math.abs(value - [west, 30, 0, north, 0, -30][i]) < 1e-6)) {
                        throw new Error('USFS canopy export changed pixel alignment, resolution, or numeric format');
                    }
                } }).then(() => undefined), refresh));
        }
    }
    return assets;
}
