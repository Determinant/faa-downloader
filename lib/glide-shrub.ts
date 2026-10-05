import { glideFetchText } from './glide-download.ts';
import { downloadGlideCover, parseGlideCoverage, type CoverService } from './glide-raster-download.ts';
import { SHRUB_ROLES, type Bounds, type ResolvedAsset } from './glide-model.ts';

export type GlideShrubServices = Record<typeof SHRUB_ROLES[number], CoverService>;

/** Published numerical RCMAP grids, not WMS colors or photographic analysis.
 * These services publish 30 m Web Mercator pixels; do not claim they are the
 * original Albers pixels. Retain their values/alignment without interpolation. */
export async function discoverGlideShrub(): Promise<GlideShrubServices> {
    const result = {} as GlideShrubServices;
    for (const role of SHRUB_ROLES) {
        const title = role === 'shrubCover' ? 'shrub' : 'shrub-height';
        const endpoint = `https://dmsdata.cr.usgs.gov/geoserver/mrlc_${title}_westernconus_year_data/wcs`;
        const url = new URL(endpoint);
        url.search = new URLSearchParams({ service: 'WCS', version: '1.0.0', request: 'DescribeCoverage' }).toString();
        result[role] = parseGlideCoverage(await glideFetchText(url.href), endpoint, 'EPSG:3857');
        if (result[role].coverage !== `mrlc_${title}_westernconus_year_data:${title}_westernconus_year_data`) {
            throw new Error(`Unexpected RCMAP ${role} coverage`);
        }
    }
    const identity = (service: CoverService) => JSON.stringify([service.time, service.origin, service.extent]);
    if (SHRUB_ROLES.some(role => identity(result[role]) !== identity(result.shrubCover))) {
        throw new Error('RCMAP shrub cover and height must have the same year and published grid');
    }
    return result;
}

export async function downloadGlideShrub(services: GlideShrubServices, bounds: Bounds,
    cache: string, refresh = false): Promise<Partial<Record<typeof SHRUB_ROLES[number], ResolvedAsset[]>>> {
    const cover = await downloadGlideCover('shrubCover', services.shrubCover, bounds, cache, refresh);
    if (!cover) return {}; // Outside the published western grid: keep shrubland excluded.
    const height = await downloadGlideCover('shrubHeight', services.shrubHeight, bounds, cache, refresh);
    if (!height) throw new Error('RCMAP shrub height does not cover the downloaded shrub grid');
    return { shrubCover: [cover], shrubHeight: [height] };
}
