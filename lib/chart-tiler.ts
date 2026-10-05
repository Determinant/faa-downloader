import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { includesCycle, isCycle, type CycleWindow } from './cycle-retention.ts';
import path from 'node:path';
import { gdalCommand, withGdal } from './gdal.ts';

import {
    CHART_DEFINITIONS,
    isIfrChartKind,
    type ChartDefinition,
    type ChartPresentation
} from './chart-definitions.ts';
import {
    DEFAULT_TILE_CONCURRENCY,
    mapWithConcurrency
} from './concurrency.ts';
import { readChartMetadata, type ChartMetadata } from './chart-metadata.ts';
import { fileExists, hasErrorCode, writeFileAtomic } from './fs-utils.ts';
import { chartLayoutForCycleDirectory, chartMbtilesPath } from './chart-paths.ts';
import { migrateChartSources } from './chart-source-layout.ts';
import { flattenChartPackages } from './chart-package-layout.ts';
import { acquireChartBuildLock } from './chart-build-lock.ts';
import { buildReceiptPath, currentBuildReceipt, withChartOutput, writeBuildReceipt,
    type ChartBuildConfiguration, type ChartBuildReceipt } from './chart-build-cache.ts';
export type { ChartBuildReceipt } from './chart-build-cache.ts';

export { sha256File } from './fs-utils.ts';
export { acquireChartBuildLock } from './chart-build-lock.ts';

const RESAMPLING = 'lanczos';
const WEBP_QUALITY = 92;
const OVERVIEW_FACTORS = ['2', '4', '8', '16', '32', '64', '128'] as const;
const TARGET_SRS = 'EPSG:3857';
const TILE_FORMAT = 'WEBP';
const TILER_VERSION = 1;
const GEOGRAPHIC_CUTLINE_SRS = 'EPSG:4326';
// FAA IFR enroute GeoTIFFs use this Lambert Conformal Conic projection. Keeping
// their four reviewed corners in this CRS makes the edges follow the raster's
// straight neatlines instead of bowing through the scale rulers in EPSG:4326.
const IFR_PROJECTION = {
    latitudeOfOrigin: 39,
    centralMeridian: -95,
    firstParallel: 45,
    secondParallel: 33,
    semiMajorAxis: 6_378_137,
    inverseFlattening: 298.257221999999
} as const;
const IFR_CUTLINE_SRS = [
    '+proj=lcc', `+lat_0=${IFR_PROJECTION.latitudeOfOrigin}`,
    `+lon_0=${IFR_PROJECTION.centralMeridian}`,
    `+lat_1=${IFR_PROJECTION.firstParallel}`,
    `+lat_2=${IFR_PROJECTION.secondParallel}`,
    '+x_0=0', '+y_0=0', `+a=${IFR_PROJECTION.semiMajorAxis}`,
    `+rf=${IFR_PROJECTION.inverseFlattening}`,
    '+units=m', '+no_defs'
].join(' ');

export type ChartCutline = {
    srs: string;
    wkt: string;
};

export type ChartManifest = {
    schemaVersion: 1;
    effectiveDate: string;
    generatedAt: string;
    charts: Array<ChartPresentation & ChartMetadata & {
        id: string;
        file: string;
        byteLength: number;
        sha256: string;
        sourceByteLength: number;
        sourceSha256: string;
        tilerVersion: number;
        buildConfigurationSha256: string;
        cutlineProvenance: ChartDefinition['provenance'];
    }>;
};

const CHART_GDAL_TOOLS = ['gdalinfo', 'gdal_translate', 'gdalwarp', 'gdaladdo'];

export async function verifyGdalTools(): Promise<void> {
    for (const command of CHART_GDAL_TOOLS) {
        await gdalCommand(command, ['--version']);
    }
    const formats = await gdalCommand('gdalinfo', ['--formats']);
    for (const format of ['WEBP', 'MBTiles']) {
        if (!formats.includes(format)) {
            throw new Error(`GDAL does not provide the required ${format} driver`);
        }
    }
}

async function findTiffs(directory: string): Promise<string[]> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const tiffs: string[] = [];
    for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory() && entry.name !== 'mbtiles') {
            tiffs.push(...await findTiffs(entryPath));
        } else if (entry.isFile() && /\.tif$/i.test(entry.name)) {
            tiffs.push(entryPath);
        }
    }
    return tiffs.sort();
}

const ifrCoordinate = (() => {
    const flattening = 1 / IFR_PROJECTION.inverseFlattening;
    const eccentricity = Math.sqrt(2 * flattening - flattening ** 2);
    const radians = Math.PI / 180;
    const latitudeOfOrigin = IFR_PROJECTION.latitudeOfOrigin * radians;
    const firstParallel = IFR_PROJECTION.firstParallel * radians;
    const secondParallel = IFR_PROJECTION.secondParallel * radians;
    const centralMeridian = IFR_PROJECTION.centralMeridian * radians;
    const m = (value: number): number => Math.cos(value) /
        Math.sqrt(1 - eccentricity ** 2 * Math.sin(value) ** 2);
    const t = (value: number): number => Math.tan(Math.PI / 4 - value / 2) /
        ((1 - eccentricity * Math.sin(value)) /
            (1 + eccentricity * Math.sin(value))) ** (eccentricity / 2);
    const cone = (Math.log(m(firstParallel)) - Math.log(m(secondParallel))) /
        (Math.log(t(firstParallel)) - Math.log(t(secondParallel)));
    const scale = m(firstParallel) / (cone * t(firstParallel) ** cone);
    const originRadius = IFR_PROJECTION.semiMajorAxis *
        scale * t(latitudeOfOrigin) ** cone;

    return ([longitude, latitude]: ChartDefinition['coordinates'][number]) => {
        const radius = IFR_PROJECTION.semiMajorAxis *
            scale * t(latitude * radians) ** cone;
        const angle = cone * (longitude * radians - centralMeridian);
        return [
            radius * Math.sin(angle),
            originRadius - radius * Math.cos(angle)
        ] as [number, number];
    };
})();

function cutlineForDefinition(definition: ChartDefinition): ChartCutline {
    const ifr = isIfrChartKind(definition.kind);
    const srs = ifr ? IFR_CUTLINE_SRS : GEOGRAPHIC_CUTLINE_SRS;
    const coordinates = ifr
        ? definition.coordinates.map(ifrCoordinate)
        : definition.coordinates;
    const first = coordinates[0];
    const ring = [...coordinates, first];
    return {
        srs,
        wkt: `POLYGON ((${ring.map(([x, y]) => `${x} ${y}`).join(', ')}))`
    };
}

export function chartCutlineForFilename(filePath: string): ChartCutline | undefined {
    const definition = CHART_DEFINITIONS[path.basename(filePath).toLowerCase()];
    if (!definition) return undefined;
    return cutlineForDefinition(definition);
}

function buildConfiguration(tifPath: string): ChartBuildConfiguration {
    const filename = path.basename(tifPath).toLowerCase();
    const definition = CHART_DEFINITIONS[filename];
    const cutline = definition
        ? {
            coordinates: definition.coordinates,
            provenance: definition.provenance,
            ...(isIfrChartKind(definition.kind)
                ? { edgeSrs: IFR_CUTLINE_SRS }
                : {})
        }
        : null;
    const configuration = {
        tilerVersion: TILER_VERSION,
        targetSrs: TARGET_SRS,
        tileFormat: TILE_FORMAT,
        webpQuality: WEBP_QUALITY,
        resampling: RESAMPLING,
        overviewFactors: OVERVIEW_FACTORS,
        paletteExpansion: 'rgb',
        destinationAlpha: true,
        cropToCutline: cutline !== null,
        zoomLevelStrategy: 'UPPER',
        cutline
    };
    return { tilerVersion: TILER_VERSION,
        configurationSha256: createHash('sha256').update(JSON.stringify(configuration)).digest('hex') };
}

export async function writeChartBuildReceipt(tifPath: string, mbtilesPath: string): Promise<ChartBuildReceipt> {
    return writeBuildReceipt(tifPath, mbtilesPath, buildConfiguration(tifPath));
}

export async function writeChartManifests(
    chartRoot: string,
    readMetadata = readChartMetadata,
    window?: CycleWindow
): Promise<void> {
    await writeChartManifestsWithReceipts(chartRoot, new Map(), readMetadata, window);
}

async function writeChartManifestsWithReceipts(
    chartRoot: string,
    verifiedReceipts: ReadonlyMap<string, ChartBuildReceipt>,
    readMetadata = readChartMetadata,
    window?: CycleWindow
): Promise<void> {
    await fs.mkdir(chartRoot, { recursive: true });
    await migrateChartSources(chartRoot);
    // Fresh downloads and sheet builds live outside the publication tree. They
    // must participate even before a PDF catalog creates charts/<cycle>/.
    const roots = [chartRoot];
    if (path.basename(path.resolve(chartRoot)) === 'charts') {
        roots.push(path.join(path.dirname(chartRoot), 'sources'), path.join(path.dirname(chartRoot), 'mbtiles'));
    }
    const cycles = new Set<string>();
    for (const root of roots) {
        const entries = await fs.readdir(root, { withFileTypes: true }).catch(error => {
            if (hasErrorCode(error, 'ENOENT')) return [];
            throw error;
        });
        for (const entry of entries) {
            if (entry.isDirectory() && isCycle(entry.name)) cycles.add(entry.name);
        }
    }
    for (const cycle of [...cycles].sort()) {
        if (window && !includesCycle(window, cycle)) continue;
        const { sourceDirectory, cacheDirectory, deliveryDirectory } = chartLayoutForCycleDirectory(path.join(chartRoot, cycle));
        await fs.mkdir(deliveryDirectory, { recursive: true });
        const release = await acquireChartBuildLock(path.join(deliveryDirectory, 'packages'));
        try {
            const charts = await mapWithConcurrency(
                Object.entries(CHART_DEFINITIONS),
                DEFAULT_TILE_CONCURRENCY,
                ([tiff, definition]) => withChartOutput(
                    path.join(sourceDirectory, tiff),
                    async filePath => {
                        const file = tiff.replace(/\.tif$/i, '.mbtiles');
                        const tifPath = path.join(sourceDirectory, tiff);
                        if (!await fileExists(filePath)) {
                            await fs.rm(buildReceiptPath(filePath), { force: true });
                            return undefined;
                        }
                        const receipt = verifiedReceipts.get(path.resolve(filePath))
                            ?? await currentBuildReceipt(tifPath, filePath, buildConfiguration(tifPath));
                        if (!receipt) {
                            throw new Error(
                                `Chart cache is stale or unverifiable: ${filePath}; rebuild the chart`
                            );
                        }
                        return {
                            id: file.replace(/\.mbtiles$/i, ''),
                            title: definition.title,
                            kind: definition.kind,
                            file,
                            // GDAL's cropped raster extent includes curved Lambert
                            // edges; family defaults and corner-only bounds do not.
                            ...await readMetadata(filePath),
                            byteLength: receipt.output.byteLength,
                            sha256: receipt.output.sha256,
                            sourceByteLength: receipt.source.byteLength,
                            sourceSha256: receipt.source.sha256,
                            tilerVersion: receipt.tilerVersion,
                            buildConfigurationSha256: receipt.configurationSha256,
                            cutlineProvenance: definition.provenance
                        };
                    }
                )
            );
            const published = charts.filter(chart => chart !== undefined)
                .sort((left, right) => left.id.localeCompare(right.id));
            const manifestPath = path.join(cacheDirectory, 'chart-manifest.json');
            const legacyManifests = [
                path.join(path.dirname(deliveryDirectory), 'chart-manifest.json'),
                path.join(deliveryDirectory, 'chart-manifest.json')
            ].filter(file => path.resolve(file) !== path.resolve(manifestPath));
            if (published.length === 0) {
                await fs.rm(manifestPath, { force: true });
                for (const file of legacyManifests) await fs.rm(file, { force: true });
                continue;
            }
            const manifest: ChartManifest = {
                schemaVersion: 1,
                effectiveDate: cycle,
                generatedAt: new Date().toISOString(),
                charts: published
            };
            await writeFileAtomic(
                manifestPath,
                `${JSON.stringify(manifest, null, 2)}\n`
            );
            await flattenChartPackages(deliveryDirectory);
            for (const file of legacyManifests) await fs.rm(file, { force: true });
        } finally { await release(); }
    }
}

export async function tileMbtilesFromTiff(
    tifPath: string,
    force = false
): Promise<ChartBuildReceipt> {
    const cutline = chartCutlineForFilename(tifPath);
    if (!cutline && /^(?:vfr-|ifr-)/.test(path.basename(tifPath).toLowerCase())) {
        throw new Error(`no reviewed chart cutline for ${path.basename(tifPath)}`);
    }
    return withChartOutput(tifPath, async mbtilesPath => {
        const basePath = mbtilesPath.replace(/\.mbtiles$/i, '');
        if (await fileExists(mbtilesPath) && !force) {
            const receipt = await currentBuildReceipt(tifPath, mbtilesPath, buildConfiguration(tifPath));
            if (receipt) {
                console.log(`file "${mbtilesPath}" is current`);
                return receipt;
            }
            console.warn(`rebuilding stale or unverifiable chart cache "${mbtilesPath}"`);
        }

        return withGdal(1, async () => {
            const workDirectory = await fs.mkdtemp(`${basePath}.work-`);
            const rgbVrtPath = path.join(workDirectory, 'rgb.vrt');
            const alphaVrtPath = path.join(workDirectory, 'alpha.vrt');
            const nextMbtilesPath = path.join(workDirectory, 'next.mbtiles');
            let sourcePath = tifPath;
            try {
                const info = await gdalCommand('gdalinfo', [sourcePath]);
                if (info.includes('ColorInterp=Palette')) {
                    await gdalCommand('gdal_translate', [
                        '-expand', 'rgb', '-of', 'VRT', sourcePath, rgbVrtPath
                    ]);
                    sourcePath = rgbVrtPath;
                }

                console.log(`rendering mbtiles for "${tifPath}"`);
                const warpArguments = [
                    '-r', RESAMPLING,
                    '-t_srs', TARGET_SRS, '-dstalpha', '-of', 'VRT'
                ];
                if (cutline) {
                    warpArguments.push(
                        '-cutline_srs', cutline.srs,
                        '-cutline', cutline.wkt,
                        '-crop_to_cutline'
                    );
                }
                warpArguments.push(sourcePath, alphaVrtPath);
                await gdalCommand('gdalwarp', warpArguments);
                await gdalCommand('gdal_translate', [
                    '-of', 'MBTILES',
                    '-co', `NAME=${path.basename(basePath)}`,
                    '-co', `DESCRIPTION=${path.basename(basePath)}`,
                    '-co', `TILE_FORMAT=${TILE_FORMAT}`,
                    '-co', `QUALITY=${WEBP_QUALITY}`,
                    '-co', `RESAMPLING=${RESAMPLING.toUpperCase()}`,
                    '-co', 'ZOOM_LEVEL_STRATEGY=UPPER',
                    alphaVrtPath,
                    nextMbtilesPath
                ]);
                await gdalCommand('gdaladdo', [
                    '-r', RESAMPLING,
                    '-oo', `TILE_FORMAT=${TILE_FORMAT}`,
                    '-oo', `QUALITY=${WEBP_QUALITY}`,
                    nextMbtilesPath,
                    ...OVERVIEW_FACTORS
                ]);
                await fs.rename(nextMbtilesPath, mbtilesPath);
                const receipt = await writeChartBuildReceipt(tifPath, mbtilesPath);
                console.log(`Wrote ${mbtilesPath}`);
                return receipt;
            } finally {
                await fs.rm(workDirectory, { recursive: true, force: true });
            }
        }, CHART_GDAL_TOOLS);
    });
}

export async function tileCharts(
    chartRoot: string,
    force = false,
    concurrency = DEFAULT_TILE_CONCURRENCY,
    window?: CycleWindow
): Promise<void> {
    return withGdal(concurrency, async () => {
        await verifyGdalTools();
        await migrateChartSources(chartRoot);
        const sources = path.join(path.dirname(chartRoot), 'sources');
        await fs.mkdir(sources, { recursive: true });
        const tiffs = (await findTiffs(sources)).filter(file => !window ||
            includesCycle(window, path.relative(sources, file).split(path.sep)[0]));
        if (tiffs.length === 0) {
            console.log(`No chart TIFFs found under ${sources}`);
            await writeChartManifestsWithReceipts(chartRoot, new Map(), undefined, window);
            return;
        }
        console.log(`Rendering ${tiffs.length} chart TIFFs with concurrency ${concurrency}`);
        const builds = await mapWithConcurrency(tiffs, concurrency, async tifPath => {
            const receipt = await tileMbtilesFromTiff(tifPath, force);
            return [
                path.resolve(chartMbtilesPath(tifPath)),
                receipt
            ] as const;
        });
        const verifiedReceipts = new Map(builds);
        await writeChartManifestsWithReceipts(chartRoot, verifiedReceipts, undefined, window);
    }, CHART_GDAL_TOOLS);
}
