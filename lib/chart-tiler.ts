import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

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
import { sha256File, writeFileAtomic } from './fs-utils.ts';
import { chartCacheDirectory, chartMbtilesPath } from './chart-paths.ts';
import { flattenChartPackages } from './chart-package-layout.ts';
import { acquireChartBuildLock } from './chart-build-lock.ts';

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
const execFileAsync = promisify(execFile);

export type ChartCutline = {
    srs: string;
    wkt: string;
};

type FileIdentity = {
    byteLength: number;
    sha256: string;
};

export type ChartBuildReceipt = {
    schemaVersion: 1;
    tilerVersion: number;
    configurationSha256: string;
    source: FileIdentity;
    output: FileIdentity;
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

async function runCommand(
    command: string,
    args: string[]
): Promise<{ stdout: string; stderr: string }> {
    try {
        return await execFileAsync(command, args, { maxBuffer: 16 * 1024 * 1024 });
    } catch (error: any) {
        const detail = String(error.stderr || error.stdout || error.message || error).trim();
        throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
    }
}

export async function verifyGdalTools(): Promise<void> {
    for (const command of ['gdalinfo', 'gdal_translate', 'gdalwarp', 'gdaladdo']) {
        await runCommand(command, ['--version']);
    }
    const formats = await runCommand('gdalinfo', ['--formats']);
    for (const format of ['WEBP', 'MBTiles']) {
        if (!formats.stdout.includes(format)) {
            throw new Error(`GDAL does not provide the required ${format} driver`);
        }
    }
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return false;
        throw error;
    }
}

function hasErrorCode(error: unknown, code: string): boolean {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === code;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function buildReceiptPath(mbtilesPath: string): string {
    return `${mbtilesPath}.build.json`;
}

function legacyTemporaryChartPaths(basePath: string): string[] {
    const nextMbtilesPath = `${basePath}.next.mbtiles`;
    const partialTilesPath = `${basePath}.next.partial_tiles.db`;
    return [
        `${basePath}-rgb.vrt`,
        `${basePath}-alpha.vrt`,
        nextMbtilesPath,
        `${nextMbtilesPath}-journal`,
        `${nextMbtilesPath}-shm`,
        `${nextMbtilesPath}-wal`,
        partialTilesPath,
        `${partialTilesPath}-journal`,
        `${partialTilesPath}-shm`,
        `${partialTilesPath}-wal`
    ];
}

async function removeStaleChartWork(basePath: string): Promise<void> {
    const directory = path.dirname(basePath);
    const prefix = `${path.basename(basePath)}.work-`;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    await Promise.all(
        entries
            .filter(entry => entry.isDirectory() && entry.name.startsWith(prefix))
            .map(entry => fs.rm(path.join(directory, entry.name), {
                recursive: true,
                force: true
            }))
    );
    await Promise.all(
        legacyTemporaryChartPaths(basePath).map(filePath => fs.rm(filePath, { force: true }))
    );
}

async function withChartOutput<T>(
    tifPath: string,
    action: (mbtilesPath: string) => Promise<T>
): Promise<T> {
    const sourceBasePath = tifPath.replace(/\.tif$/i, '');
    const mbtilesPath = chartMbtilesPath(tifPath);
    // Keep the lock keyed to the source so old and new layout builds cannot race.
    const releaseLock = await acquireChartBuildLock(sourceBasePath);
    try {
        await fs.mkdir(path.dirname(mbtilesPath), { recursive: true });
        await removeStaleChartWork(sourceBasePath);
        await removeStaleChartWork(mbtilesPath.replace(/\.mbtiles$/i, ''));
        const moves: Array<[string, string]> = [];
        const oldPaths = [
            `${sourceBasePath}.mbtiles`,
            path.join(path.dirname(tifPath), 'mbtiles', path.basename(mbtilesPath))
        ].filter(file => path.resolve(file) !== path.resolve(mbtilesPath));
        const destinations = new Set<string>();
        for (const legacyPath of oldPaths) {
            for (const suffix of ['', '.build.json']) {
                const source = `${legacyPath}${suffix}`;
                const destination = `${mbtilesPath}${suffix}`;
                if (!await fileExists(source)) continue;
                if (await fileExists(destination) || destinations.has(destination)) {
                    throw new Error(`Chart layout conflict: both ${source} and ${destination} exist`);
                }
                moves.push([source, destination]);
                destinations.add(destination);
            }
        }
        // Receipts contain content identities, not paths: relocating does not
        // invalidate a verified build or require rendering several GB again.
        // Check both destinations first; resume safely if an earlier move stopped
        // between the archive and its receipt. Never overwrite a destination.
        for (const [source, destination] of moves) await fs.rename(source, destination);
        return await action(mbtilesPath);
    } finally {
        await releaseLock();
    }
}

function configurationSha256(tifPath: string): string {
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
    return createHash('sha256').update(JSON.stringify(configuration)).digest('hex');
}

async function fileIdentity(filePath: string): Promise<FileIdentity> {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size === 0) {
        throw new Error(`Chart artifact is empty or is not a regular file: ${filePath}`);
    }
    return { byteLength: stat.size, sha256: await sha256File(filePath) };
}

function parseBuildReceipt(value: unknown): ChartBuildReceipt | null {
    if (!isObject(value) || value.schemaVersion !== 1 ||
        !Number.isSafeInteger(value.tilerVersion) ||
        typeof value.configurationSha256 !== 'string' ||
        !isObject(value.source) || !isObject(value.output)) {
        return null;
    }
    const identities = [value.source, value.output];
    if (!identities.every(identity =>
        Number.isSafeInteger(identity.byteLength) && Number(identity.byteLength) > 0 &&
        typeof identity.sha256 === 'string' && /^[a-f0-9]{64}$/.test(identity.sha256)
    )) {
        return null;
    }
    return value as ChartBuildReceipt;
}

async function readBuildReceipt(receiptPath: string): Promise<ChartBuildReceipt | null> {
    try {
        return parseBuildReceipt(JSON.parse(await fs.readFile(receiptPath, 'utf8')));
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT') || error instanceof SyntaxError) return null;
        throw error;
    }
}

async function currentBuildReceipt(
    tifPath: string,
    mbtilesPath: string
): Promise<ChartBuildReceipt | null> {
    const receipt = await readBuildReceipt(buildReceiptPath(mbtilesPath));
    if (!receipt || receipt.tilerVersion !== TILER_VERSION ||
        receipt.configurationSha256 !== configurationSha256(tifPath)) {
        return null;
    }
    let source: FileIdentity;
    let output: FileIdentity;
    try {
        [source, output] = await Promise.all([
            fileIdentity(tifPath),
            fileIdentity(mbtilesPath)
        ]);
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return null;
        throw error;
    }
    return source.byteLength === receipt.source.byteLength &&
        source.sha256 === receipt.source.sha256 &&
        output.byteLength === receipt.output.byteLength &&
        output.sha256 === receipt.output.sha256
        ? receipt
        : null;
}

export async function writeChartBuildReceipt(
    tifPath: string,
    mbtilesPath: string
): Promise<ChartBuildReceipt> {
    const [source, output] = await Promise.all([
        fileIdentity(tifPath),
        fileIdentity(mbtilesPath)
    ]);
    const receipt: ChartBuildReceipt = {
        schemaVersion: 1,
        tilerVersion: TILER_VERSION,
        configurationSha256: configurationSha256(tifPath),
        source,
        output
    };
    await writeFileAtomic(
        buildReceiptPath(mbtilesPath),
        `${JSON.stringify(receipt, null, 2)}\n`
    );
    return receipt;
}

export async function writeChartManifests(
    chartRoot: string,
    readMetadata = readChartMetadata
): Promise<void> {
    await writeChartManifestsWithReceipts(chartRoot, new Map(), readMetadata);
}

async function writeChartManifestsWithReceipts(
    chartRoot: string,
    verifiedReceipts: ReadonlyMap<string, ChartBuildReceipt>,
    readMetadata = readChartMetadata
): Promise<void> {
    const entries = await fs.readdir(chartRoot, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory() || !isIsoDate(entry.name)) continue;
        const cycleDirectory = path.join(chartRoot, entry.name);
        const deliveryDirectory = path.join(cycleDirectory, 'mbtiles');
        await fs.mkdir(deliveryDirectory, { recursive: true });
        const release = await acquireChartBuildLock(path.join(deliveryDirectory, 'packages'));
        try {
            const charts = await mapWithConcurrency(
                Object.entries(CHART_DEFINITIONS),
                DEFAULT_TILE_CONCURRENCY,
                ([tiff, definition]) => withChartOutput(
                    path.join(cycleDirectory, tiff),
                    async filePath => {
                        const file = tiff.replace(/\.tif$/i, '.mbtiles');
                        const tifPath = path.join(cycleDirectory, tiff);
                        if (!await fileExists(filePath)) {
                            await fs.rm(buildReceiptPath(filePath), { force: true });
                            return undefined;
                        }
                        const receipt = verifiedReceipts.get(path.resolve(filePath))
                            ?? await currentBuildReceipt(tifPath, filePath);
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
            const manifestPath = path.join(chartCacheDirectory(cycleDirectory), 'chart-manifest.json');
            const legacyManifests = [
                path.join(cycleDirectory, 'chart-manifest.json'),
                path.join(deliveryDirectory, 'chart-manifest.json')
            ].filter(file => path.resolve(file) !== path.resolve(manifestPath));
            if (published.length === 0) {
                await fs.rm(manifestPath, { force: true });
                for (const file of legacyManifests) await fs.rm(file, { force: true });
                continue;
            }
            const manifest: ChartManifest = {
                schemaVersion: 1,
                effectiveDate: entry.name,
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

function isIsoDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
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
            const receipt = await currentBuildReceipt(tifPath, mbtilesPath);
            if (receipt) {
                console.log(`file "${mbtilesPath}" is current`);
                return receipt;
            }
            console.warn(`rebuilding stale or unverifiable chart cache "${mbtilesPath}"`);
        }

        const workDirectory = await fs.mkdtemp(`${basePath}.work-`);
        const rgbVrtPath = path.join(workDirectory, 'rgb.vrt');
        const alphaVrtPath = path.join(workDirectory, 'alpha.vrt');
        const nextMbtilesPath = path.join(workDirectory, 'next.mbtiles');
        let sourcePath = tifPath;
        try {
            const info = await runCommand('gdalinfo', [sourcePath]);
            if (info.stdout.includes('ColorInterp=Palette')) {
                await runCommand('gdal_translate', [
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
            await runCommand('gdalwarp', warpArguments);
            await runCommand('gdal_translate', [
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
            await runCommand('gdaladdo', [
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
    });
}

export async function tileCharts(
    chartRoot: string,
    force = false,
    concurrency = DEFAULT_TILE_CONCURRENCY
): Promise<void> {
    await verifyGdalTools();
    const tiffs = await findTiffs(chartRoot);
    if (tiffs.length === 0) {
        console.log(`No chart TIFFs found under ${chartRoot}`);
        await writeChartManifests(chartRoot);
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
    await writeChartManifestsWithReceipts(chartRoot, verifiedReceipts);
}
