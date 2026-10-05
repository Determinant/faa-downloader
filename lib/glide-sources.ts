import fs from 'node:fs/promises';
import path from 'node:path';
import { matchesFile } from './build-cache.ts';
import { InvalidDownloadError } from './download-validation.ts';
import { downloadFile } from './http-download.ts';
import { fileExists, sha256File } from './fs-utils.ts';
import { gdalCommand } from './gdal.ts';
import { cachedGlideSource } from './glide-download.ts';
import { GLIDE_RULES, ALL_RASTER_ROLES, OPTIONAL_RASTER_ROLES, SHRUB_ROLES, VECTOR_ROLES, OPTIONAL_VECTOR_ROLES,
    type GlideInventory, type GlideSourceRegion, type RasterRole, type ResolvedAsset, type ResolvedRegion, type SourceAsset } from './glide-model.ts';

/** Local originals can be shared with other builders; only remote inputs are copied into glide-cache. */
export async function resolveGlideSources(inventory: GlideInventory, sourceFile: string, cache: string): Promise<ResolvedRegion[]> {
    const resolved = new Map<string, Promise<ResolvedAsset>>();
    const resolve = (asset: SourceAsset) => {
        const key = JSON.stringify(asset);
        if (!resolved.has(key)) resolved.set(key, (async () => {
            let file: string;
            if (asset.file) file = path.resolve(path.dirname(sourceFile), asset.file);
            else {
                const extension = path.extname(new URL(asset.url).pathname).toLowerCase();
                if (!['.tif', '.tiff', '.geojson', '.json', '.gpkg'].includes(extension)) {
                    throw new Error(`Unsupported glide input: ${asset.url}`);
                }
                file = path.join(cache, 'sources', `${asset.sha256}${extension}`);
                if (!await matchesFile(file, asset)) {
                    await downloadFile(asset.url, file, { userAgent: 'faa-downloader/build-glide',
                        validationKey: asset.sha256, validate: async candidate => {
                            if (!await matchesFile(candidate, asset)) throw new InvalidDownloadError(`Glide input identity mismatch: ${asset.name}`);
                        } });
                }
            }
            const stat = await fs.stat(file);
            if (!stat.isFile() || stat.size <= 0) throw new Error(`Empty glide source: ${file}`);
            const sha256 = await sha256File(file);
            if ((asset.sha256 && asset.sha256 !== sha256) || (asset.bytes !== undefined && asset.bytes !== stat.size)) {
                throw new Error(`Glide input identity mismatch: ${asset.name}`);
            }
            return { ...asset, file, sha256, bytes: stat.size };
        })());
        return resolved.get(key)!;
    };
    const regions: ResolvedRegion[] = [];
    for (const region of inventory.regions) {
        const sources = {} as ResolvedRegion['sources'];
        // Bound simultaneous source transfers and hashing, including on national inventories.
        for (const role of [...ALL_RASTER_ROLES, ...VECTOR_ROLES, ...OPTIONAL_VECTOR_ROLES]) {
            if (!region.sources[role]) continue;
            sources[role] = [];
            for (const asset of region.sources[role]) sources[role].push(await resolve(asset));
        }
        regions.push({ ...region, sources });
    }
    return regions;
}

export async function inspectGlideRaster(file: string, role: RasterRole): Promise<void> {
    const info = JSON.parse(await gdalCommand('gdalinfo', ['-json', '-noct', '-norat', file]));
    const band = info.bands?.[0], gt = info.geoTransform, crs = info.stac?.['proj:projjson'];
    const axes = crs?.coordinate_system?.axis;
    // Check horizontal axis units, not the ellipsoid's metre unit nested inside every CRS.
    const geographic = crs?.type === 'GeographicCRS' && axes?.length === 2 && axes.every(axis => axis.unit === 'degree');
    const metres = crs?.type === 'ProjectedCRS' && axes?.length === 2 && axes.every(axis => axis.unit === 'metre' ||
        (axis.unit?.type === 'LinearUnit' && axis.unit.conversion_factor === 1));
    const pixelM = gt && Math.max(Math.abs(gt[1]), Math.abs(gt[5])) * (geographic ? 111320 : 1);
    if (info.driverShortName !== 'GTiff' || info.bands?.length !== 1 ||
        !['Byte', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Float32', 'Float64'].includes(band?.type) ||
        !gt || gt.length !== 6 || !gt.every(Number.isFinite) || gt[1] <= 0 || gt[5] >= 0 || gt[2] || gt[4] ||
        (!geographic && !metres) || (band.scale !== undefined && band.scale !== 1) ||
        (band.offset !== undefined && band.offset !== 0) ||
        (role !== 'elevation' && !['Byte', 'UInt16', 'Int16'].includes(band.type)) ||
        pixelM > (role === 'elevation' || role === 'fineLandcover' ? GLIDE_RULES.maxElevationPixelM : GLIDE_RULES.maxCoverPixelM) ||
        (role === 'elevation' && band.unit && !['m', 'metre', 'meter'].includes(band.unit))) {
        throw new Error(`${role}: expected north-up, single-band GeoTIFF in metres/geographic CRS, ` +
            `unscaled ${role === 'elevation' ? 'metre elevations at ≤12 m' : role === 'fineLandcover' ? 'integer cover at ≤12 m' : 'integer cover at ≤40 m'}: ${file}`);
    }
    // External masks/metadata would make a hash of just the TIFF insufficient for cache identity.
    if (info.files?.some((name: string) => path.resolve(name) !== path.resolve(file))) {
        throw new Error(`Embed raster masks/metadata in the GeoTIFF before building glide: ${file}`);
    }
}

type CoverRole = Exclude<RasterRole, 'elevation'>;
type ElevationRaster = { values: string; known: string };
type CoverRaster = { eligible: string; cultivated?: string; shrub?: string; urban?: string; bare?: string; mappedOnly?: string;
    disputed?: string; excluded?: string; trees?: string; water?: string; oldestDate?: string; newestDate?: string };
export type GlideRasterSources = { elevation: ElevationRaster; ground?: ResolvedAsset[] } &
    Record<Exclude<CoverRole, typeof OPTIONAL_RASTER_ROLES[number]>, CoverRaster> &
    Partial<Record<typeof OPTIONAL_RASTER_ROLES[number], CoverRaster>>;
let maskGdalVersion: Promise<string> | undefined;

/** Classify before reprojection: a mixture of allowed classes is allowed, but
 * a disallowed class between two numeric codes can never disappear in extrema. */
export function glideCoverClass(role: Exclude<RasterRole, 'elevation'>, code: number, shrubs = false): number {
    if (!Number.isInteger(code) || code < 0) return 0;
    // WorldCover: native 10 m open-ground evidence for purple only. Bare
    // substrate still needs agreement with NLCD bare land; trees, built land,
    // shrubs, wetland, water and unknown pixels cannot corroborate an opening.
    if (role === 'fineLandcover') return [30, 40].includes(code) ? 2 : code === 60 ? 1 : code === 10 ? 3 : [80, 90, 95].includes(code) ? 4 : 0;
    if (role === 'landcover' && code === GLIDE_RULES.bareLandcover) return 5;
    if (role === 'landcover' && code === GLIDE_RULES.urbanOpenLandcover) return 4;
    if (role === 'landcover' && [22, 23, 24].includes(code)) return 6; // Requires mapped open ground.
    // Potential only: recovering a coarse forest disagreement requires BOTH
    // mapped grass and fine open pixels, plus strict canopy and low impervious.
    if (role === 'landcover' && [41, 42, 43].includes(code)) return 7;
    if (role === 'landcover' && shrubs && code === GLIDE_RULES.shrubLandcover) return 3;
    if (role === 'landcover') return GLIDE_RULES.allowedLandcover.some(value => value === code) ?
        (code === GLIDE_RULES.cultivatedLandcover ? 2 : 1) : 0;
    if (role === 'shrubCover' || role === 'shrubHeight') {
        // Larger value means better evidence. Classify before min reduction so
        // one tall/dense/unknown native pixel cannot be averaged into acceptance.
        const index = GLIDE_RULES.shrubBands.findIndex(band => code <=
            (role === 'shrubCover' ? band.maxCoverPercent : band.maxMeanHeightCm));
        return index < 0 ? 0 : GLIDE_RULES.shrubBands.length - index;
    }
    if (role === 'canopy') return code <= GLIDE_RULES.maxCanopyPercent ? 2 : Number(code <= GLIDE_RULES.mappedOpenMaxCanopyPercent);
    // Legacy inventories can still supply this source, but it cannot override TCC.
    if (role === 'shrubTreeCover') return Number(code === 0);
    return code <= GLIDE_RULES.maxImperviousPercent ? 3 : code <= GLIDE_RULES.maxFallbackImperviousPercent ? 2 : Number(code <= GLIDE_RULES.mappedOpenMaxImperviousPercent);
}

async function inspectGlideVector(file: string): Promise<void> {
    const info = JSON.parse(await gdalCommand('ogrinfo', ['-json', '-so', '-al', file]));
    if (!['GeoJSON', 'GPKG'].includes(info.driverShortName) || info.layers?.length !== 1 ||
        info.layers[0].geometryFields?.length !== 1 || !info.layers[0].geometryFields[0].coordinateSystem) {
        throw new Error(`Glide hazards require one georeferenced GeoJSON/GeoPackage layer: ${file}`);
    }
    if (info.driverShortName === 'GPKG') for (const suffix of ['-wal', '-journal', '-shm']) {
        if (await fileExists(`${file}${suffix}`)) throw new Error(`Close/checkpoint the source GeoPackage before building glide: ${file}`);
    }
    const layer = info.layers[0], quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
    const geometry = quote(layer.geometryFields[0].name || 'geometry');
    const result = JSON.parse(await gdalCommand('ogr2ogr', ['-f', 'GeoJSON', '-dialect', 'SQLite',
        '-sql', `SELECT COUNT(*) AS invalid FROM ${quote(layer.name)} WHERE ${geometry} IS NULL OR NOT ST_IsValid(${geometry})`, '/vsistdout/', file]));
    if (result.features?.[0]?.properties?.invalid !== 0) throw new Error(`Invalid or unlocated glide hazard: ${file}`);
}

export async function inspectGlideVectors(region: ResolvedRegion): Promise<void> {
    for (const role of VECTOR_ROLES) for (const asset of region.sources[role]) await inspectGlideVector(asset.file);
}

export async function prepareGlideRasters(region: ResolvedRegion, directory: string, cache = directory): Promise<GlideRasterSources> {
    const sources = {} as GlideRasterSources;
    if (region.sources.ground?.length) {
        for (const asset of region.sources.ground) await inspectGlideVector(asset.file);
        sources.ground = region.sources.ground;
    }
    sources.elevation = await prepareGlideRasterRole(region.sources.elevation, 'elevation', directory, cache);
    for (const role of ['landcover', 'canopy', 'impervious'] as const) {
        sources[role] = await prepareGlideRasterRole(region.sources[role], role, directory, cache,
            Boolean(region.sources.shrubCover?.length && region.sources.shrubHeight?.length));
    }
    for (const role of [...SHRUB_ROLES, 'fineLandcover'] as const) if (region.sources[role]?.length) {
        sources[role] = await prepareGlideRasterRole(region.sources[role], role, directory, cache);
    }
    return sources;
}

async function prepareRasterMosaic(assets: ResolvedAsset[], role: RasterRole, directory: string): Promise<ElevationRaster> {
    const files: string[] = [];
    for (const [index, asset] of assets.entries()) {
        await inspectGlideRaster(asset.file, role);
        const floating = path.join(directory, `${role}-${index}.vrt`);
        // Float32 permits NaN in uncovered mosaic cells even for Byte cover sources.
        await gdalCommand('gdal_translate', ['-q', '-of', 'VRT', '-ot', 'Float32', asset.file, floating]);
        files.push(floating);
    }
    const values = path.join(directory, `${role}.vrt`), known = path.join(directory, `${role}-known.vrt`);
    await gdalCommand('gdalbuildvrt', ['-strict', '-resolution', 'highest', '-vrtnodata', 'nan', values, ...files]);
    // Extract the VRT's validity mask explicitly. Value resamplers can otherwise
    // ignore NoData contributors and make a partially unknown cell look usable.
    await gdalCommand('gdal_translate', ['-q', '-of', 'VRT', '-b', 'mask', values, known]);
    return { values, known };
}

export function prepareGlideRasterRole(assets: ResolvedAsset[], role: 'elevation', directory: string, cache?: string): Promise<ElevationRaster>;
export function prepareGlideRasterRole(assets: ResolvedAsset[], role: CoverRole, directory: string, cache?: string, shrubs?: boolean): Promise<CoverRaster>;
export async function prepareGlideRasterRole(assets: ResolvedAsset[], role: RasterRole, directory: string, cache = directory, shrubs = false): Promise<ElevationRaster | CoverRaster> {
    if (!assets.length) throw new Error(`${role}: no source rasters`);
    if (role === 'elevation') return prepareRasterMosaic(assets, role, directory);
    const lut = [-32768, -1, ...Array.from({ length: role === 'shrubHeight' ? 502 : 256 }, (_, i) => i), 65535]
        .map(code => `${code}:${glideCoverClass(role, code, shrubs)}`).join(',');
    const mask = await cachedGlideSource(cache, { kind: 'native-cover-mask-v6-lut2', role, lut,
        assets: assets.map(({ sha256, bytes }) => ({ sha256, bytes })),
        gdal: await (maskGdalVersion ??= gdalCommand('gdal_translate', ['--version']).then(value => value.trim())) }, {
        name: `${role} eligibility mask`, date: assets[0].date, attribution: 'Derived preparation mask; original source attribution in provenance'
    }, 'tif', async file => {
        const { values } = await prepareRasterMosaic(assets, role, directory);
        // Native GDAL lookup, evaluated once and cached. Preserve every source's
        // NODATA / UseMaskBand handling. Unknown/background pixels initialize to
        // zero, which remains a real excluded contributor in subsequent min warps.
        const classified = path.join(directory, `${role}-classes.vrt`);
        const vrt = (await fs.readFile(values, 'utf8')).replaceAll('SimpleSource', 'ComplexSource')
            .replace(/dataType="Float32"/g, 'dataType="Byte"')
            .replace(/<NoDataValue>[^<]*<\/NoDataValue>/g, '<NoDataValue>0</NoDataValue>')
            .replace(/<ColorTable>[\s\S]*?<\/ColorTable>/g, '')
            .replace(/<ColorInterp>[^<]*<\/ColorInterp>/g, '<ColorInterp>Gray</ColorInterp>')
            .replaceAll('</ComplexSource>', `<LUT>${lut}</LUT></ComplexSource>`);
        await fs.writeFile(classified, vrt);
        await gdalCommand('gdal_translate', ['-q', '-of', 'GTiff', '-ot', 'Byte', '-a_nodata', 'none',
            '-co', 'COMPRESS=DEFLATE', '-co', 'TILED=YES', classified, file]);
    });
    const dates = { oldestDate: assets.map(a => a.date).sort()[0], newestDate: assets.map(a => a.date).sort().at(-1)! };
    if (role !== 'landcover' && role !== 'fineLandcover') return { eligible: mask.file, ...dates };
    // Independent max-reduced flags preserve BOTH crop and shrub contributors
    // when a target cell overlaps multiple native classes.
    const base = path.join(directory, `${role}-flags.vrt`);
    await gdalCommand('gdal_translate', ['-q', '-of', 'VRT', mask.file, base]);
    const vrt = (await fs.readFile(base, 'utf8')).replaceAll('SimpleSource', 'ComplexSource');
    const flags: Partial<CoverRaster> = {};
    const fields = role === 'fineLandcover' ? [['excluded', [3, 4]], ['trees', [3]], ['water', [4]]] as const :
        [['cultivated', [2]], ['shrub', [3]], ['urban', [4]], ['bare', [5]], ['mappedOnly', [6]], ['disputed', [7]]] as const;
    for (const [name, codes] of fields) {
        if (name === 'shrub' && !shrubs) continue;
        flags[name] = path.join(directory, `${role}-${name}.vrt`);
        const flagLut = [0, 1, 2, 3, 4, 5, 6, 7, 255].map(value => `${value}:${Number((codes as readonly number[]).includes(value))}`).join(',');
        await fs.writeFile(flags[name], vrt.replaceAll('</ComplexSource>', `<LUT>${flagLut}</LUT></ComplexSource>`));
    }
    return { eligible: mask.file, ...flags, ...dates };
}

export function glideProvenance(regions: GlideSourceRegion[]) {
    return { schemaVersion: 1, regions: regions.map(region => ({ id: region.id,
        bounds: region.bounds, coverageBounds: region.coverageBounds,
        ...('screenedOut' in region ? { screenedOut: region.screenedOut } : {}),
        sources: Object.fromEntries(Object.entries(region.sources).map(([role, assets]) => [role,
            assets.map(({ name, date, attribution, url, revision, sha256, bytes, obstacleSource, buildingSource, roadSource, groundSource }) =>
                ({ name, date, attribution, url, revision, sha256, bytes, obstacleSource, buildingSource, roadSource, groundSource }))])) })) };
}
