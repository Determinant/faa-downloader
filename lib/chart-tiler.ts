import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { writeFileAtomic } from './fs-utils.ts';

const RESAMPLING = 'lanczos';
const WEBP_QUALITY = 92;
const OVERVIEW_FACTORS = ['2', '4', '8', '16', '32', '64', '128'] as const;
const TARGET_SRS = 'EPSG:3857';
const TILE_FORMAT = 'WEBP';
const TILER_VERSION = 1;
const CHARTMAKER_PROVENANCE =
    'N129BZ/chartmaker@1d71db443916b8052dde41d612c3311bac25a5ae';
const MEASURED_FLYWAY_PROVENANCE = 'local-measurement@faa-raster-2026-09-03';
const execFileAsync = promisify(execFile);

type LongitudeLatitude = readonly [longitude: number, latitude: number];

type ChartCutline = {
    coordinates: readonly LongitudeLatitude[];
    provenance: typeof CHARTMAKER_PROVENANCE | typeof MEASURED_FLYWAY_PROVENANCE;
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

type ChartKind = 'vfr-sectional' | 'vfr-terminal' | 'vfr-flyway' | 'ifr-low';

type ChartPresentation = {
    title: string;
    kind: ChartKind;
    minZoom: number;
    maxZoom: number;
};

export type ChartManifest = {
    schemaVersion: 1;
    effectiveDate: string;
    generatedAt: string;
    charts: Array<ChartPresentation & {
        id: string;
        file: string;
        bounds: [west: number, south: number, east: number, north: number];
        byteLength: number;
        sha256: string;
        sourceByteLength: number;
        sourceSha256: string;
        tilerVersion: number;
        buildConfigurationSha256: string;
        cutlineProvenance: ChartCutline['provenance'];
    }>;
};

function chartmakerCutline(coordinates: readonly LongitudeLatitude[]): ChartCutline {
    return {
        coordinates,
        provenance: CHARTMAKER_PROVENANCE
    };
}

function measuredFlywayCutline(coordinates: readonly LongitudeLatitude[]): ChartCutline {
    return { coordinates, provenance: MEASURED_FLYWAY_PROVENANCE };
}

// FAA rasters include the complete printed sheet, but only the main body inside the
// neatline is accurately georeferenced. Geographic cutlines remain stable when pixel
// dimensions change between cycles. Sectional, TAC, and IFR polygons are adapted from
// N129BZ/chartmaker commit 1d71db443916b8052dde41d612c3311bac25a5ae. Flyway polygons
// were measured from the 2026-09-03 FAA rasters because chartmaker does not publish them.
const CHART_CUTLINES = {
    'vfr-sectional-las_vegas.tif': chartmakerCutline([
        [-117.9364037, 40.0302008],
        [-110.7654255, 40.0217622],
        [-110.9497411, 35.6129585],
        [-115.3507031, 35.6627363],
        [-117.9293341, 35.6258583]
    ]),
    'vfr-sectional-los_angeles.tif': chartmakerCutline([
        [-121.6174638, 36.1022061],
        [-119.8891148, 36.1380044],
        [-118.8381774, 36.1431171],
        [-117.4010521, 36.1380044],
        [-116.2361576, 36.1277780],
        [-115.4384581, 36.1073212],
        [-114.5521253, 36.0919751],
        [-114.7547157, 32.0073689],
        [-120.0980361, 31.9966312],
        [-120.1296909, 33.5561808],
        [-122.0099826, 33.5456285],
        [-122.0036516, 34.2288425],
        [-121.5351614, 34.2393106]
    ]),
    'vfr-sectional-san_francisco.tif': chartmakerCutline([
        [-124.9799519, 40.2040795],
        [-123.4685695, 40.2396587],
        [-122.1201684, 40.2498947],
        [-120.7031642, 40.2454651],
        [-119.2094844, 40.2283077],
        [-117.6799031, 40.1903398],
        [-117.7352113, 39.1253284],
        [-117.7849207, 38.2628965],
        [-117.8201948, 37.3906311],
        [-117.8879928, 36.0182349],
        [-119.1420907, 36.0134553],
        [-120.3536795, 36.0171455],
        [-121.9218280, 36.0251811],
        [-123.4629973, 36.0175673],
        [-124.9771074, 36.0194916]
    ]),
    'vfr-terminal-las_vegas.tif': chartmakerCutline([
        [-115.6113964, 36.7311736],
        [-113.8718172, 36.7279904],
        [-113.8817463, 35.6961824],
        [-115.6133822, 35.6961824]
    ]),
    'vfr-terminal-los_angeles.tif': chartmakerCutline([
        [-119.1473072, 34.5156185],
        [-116.7933348, 34.5131413],
        [-116.8113729, 33.4185800],
        [-119.1262628, 33.4160704]
    ]),
    'vfr-terminal-san_diego.tif': chartmakerCutline([
        [-117.9774441, 33.6097533],
        [-116.2928819, 33.6079383],
        [-116.2994197, 32.4992459],
        [-117.9643686, 32.5047597]
    ]),
    'vfr-terminal-san_francisco.tif': chartmakerCutline([
        [-123.1614591, 38.1860050],
        [-121.3794589, 38.1860050],
        [-121.3834815, 37.0051811],
        [-123.1473800, 37.0116055]
    ]),
    'vfr-terminal-las_vegas-flyway.tif': measuredFlywayCutline([
        [-115.6206143, 36.7335859],
        [-113.8640911, 36.7282806],
        [-113.8810639, 35.6960094],
        [-115.6131342, 35.7012372]
    ]),
    'vfr-terminal-los_angeles-flyway.tif': measuredFlywayCutline([
        [-119.1506369, 34.5167127],
        [-116.7919421, 34.5160958],
        [-116.8094547, 33.4104841],
        [-119.1339565, 33.4110912]
    ]),
    'vfr-terminal-san_diego-flyway.tif': measuredFlywayCutline([
        [-117.9808246, 33.6110718],
        [-116.2873074, 33.6105635],
        [-116.2999752, 32.5001958],
        [-117.9690959, 32.5006960]
    ]),
    'vfr-terminal-san_francisco-flyway.tif': measuredFlywayCutline([
        [-123.1630347, 38.1881322],
        [-121.3710227, 38.1883972],
        [-121.3852576, 37.0079315],
        [-123.1482484, 37.0076709]
    ]),
    'ifr-enroute-low-l02.tif': chartmakerCutline([
        [-124.8741167, 42.7766746],
        [-121.5724209, 43.1159202],
        [-120.6798624, 37.2771615],
        [-123.7682233, 36.9747908]
    ]),
    'ifr-enroute-low-l03.tif': chartmakerCutline([
        [-123.5471038, 38.6166339],
        [-120.6999909, 39.7247453],
        [-117.3713560, 33.7509157],
        [-120.0793236, 32.7470033]
    ]),
    'ifr-enroute-low-l04.tif': chartmakerCutline([
        [-120.6656026, 34.9512527],
        [-114.5099049, 34.3990029],
        [-114.8709389, 32.2482623],
        [-120.8773507, 32.7983886]
    ])
} satisfies Readonly<Record<string, ChartCutline>>;

const CHART_PRESENTATION = {
    'vfr-sectional-las_vegas.tif': {
        title: 'Sectional · Las Vegas', kind: 'vfr-sectional', minZoom: 7, maxZoom: 12
    },
    'vfr-sectional-los_angeles.tif': {
        title: 'Sectional · Los Angeles', kind: 'vfr-sectional', minZoom: 7, maxZoom: 12
    },
    'vfr-sectional-san_francisco.tif': {
        title: 'Sectional · San Francisco', kind: 'vfr-sectional', minZoom: 5, maxZoom: 12
    },
    'vfr-terminal-las_vegas.tif': {
        title: 'Terminal · Las Vegas', kind: 'vfr-terminal', minZoom: 8, maxZoom: 13
    },
    'vfr-terminal-los_angeles.tif': {
        title: 'Terminal · Los Angeles', kind: 'vfr-terminal', minZoom: 8, maxZoom: 13
    },
    'vfr-terminal-san_diego.tif': {
        title: 'Terminal · San Diego', kind: 'vfr-terminal', minZoom: 8, maxZoom: 13
    },
    'vfr-terminal-san_francisco.tif': {
        title: 'Terminal · San Francisco', kind: 'vfr-terminal', minZoom: 8, maxZoom: 13
    },
    'vfr-terminal-las_vegas-flyway.tif': {
        title: 'Flyway · Las Vegas', kind: 'vfr-flyway', minZoom: 8, maxZoom: 13
    },
    'vfr-terminal-los_angeles-flyway.tif': {
        title: 'Flyway · Los Angeles', kind: 'vfr-flyway', minZoom: 8, maxZoom: 13
    },
    'vfr-terminal-san_diego-flyway.tif': {
        title: 'Flyway · San Diego', kind: 'vfr-flyway', minZoom: 8, maxZoom: 13
    },
    'vfr-terminal-san_francisco-flyway.tif': {
        title: 'Flyway · San Francisco', kind: 'vfr-flyway', minZoom: 8, maxZoom: 13
    },
    'ifr-enroute-low-l02.tif': {
        title: 'IFR Low · L02', kind: 'ifr-low', minZoom: 5, maxZoom: 12
    },
    'ifr-enroute-low-l03.tif': {
        title: 'IFR Low · L03', kind: 'ifr-low', minZoom: 7, maxZoom: 12
    },
    'ifr-enroute-low-l04.tif': {
        title: 'IFR Low · L04', kind: 'ifr-low', minZoom: 7, maxZoom: 12
    }
} satisfies Record<keyof typeof CHART_CUTLINES, ChartPresentation>;

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
        if (entry.isDirectory()) tiffs.push(...await findTiffs(entryPath));
        else if (entry.isFile() && /\.tif$/i.test(entry.name)) tiffs.push(entryPath);
    }
    return tiffs.sort();
}

export function chartCutlineForFilename(filePath: string): string | undefined {
    const cutline = CHART_CUTLINES[path.basename(filePath).toLowerCase()];
    if (!cutline) return undefined;
    const first = cutline.coordinates[0];
    if (!first || cutline.coordinates.length < 3) {
        throw new Error(`invalid chart cutline for ${path.basename(filePath)}`);
    }
    const ring = [...cutline.coordinates, first];
    return `POLYGON ((${ring.map(([longitude, latitude]) =>
        `${longitude} ${latitude}`
    ).join(', ')}))`;
}

function buildReceiptPath(mbtilesPath: string): string {
    return `${mbtilesPath}.build.json`;
}

function configurationSha256(tifPath: string): string {
    const filename = path.basename(tifPath).toLowerCase();
    const cutline = CHART_CUTLINES[filename as keyof typeof CHART_CUTLINES] ?? null;
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

export async function writeChartManifests(chartRoot: string): Promise<void> {
    await writeChartManifestsWithReceipts(chartRoot, new Map());
}

async function writeChartManifestsWithReceipts(
    chartRoot: string,
    verifiedReceipts: ReadonlyMap<string, ChartBuildReceipt>
): Promise<void> {
    const entries = await fs.readdir(chartRoot, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory() || !isIsoDate(entry.name)) continue;
        const cycleDirectory = path.join(chartRoot, entry.name);
        const charts = await Promise.all(
            Object.entries(CHART_PRESENTATION).map(async ([tiff, presentation]) => {
                const definition = CHART_CUTLINES[tiff as keyof typeof CHART_CUTLINES];
                const file = tiff.replace(/\.tif$/i, '.mbtiles');
                const filePath = path.join(cycleDirectory, file);
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
                    ...presentation,
                    file,
                    bounds: boundsForCoordinates(definition.coordinates),
                    byteLength: receipt.output.byteLength,
                    sha256: receipt.output.sha256,
                    sourceByteLength: receipt.source.byteLength,
                    sourceSha256: receipt.source.sha256,
                    tilerVersion: receipt.tilerVersion,
                    buildConfigurationSha256: receipt.configurationSha256,
                    cutlineProvenance: definition.provenance
                };
            })
        );
        const published = charts.filter(chart => chart !== undefined)
            .sort((left, right) => left.id.localeCompare(right.id));
        const manifestPath = path.join(cycleDirectory, 'chart-manifest.json');
        if (published.length === 0) {
            await fs.rm(manifestPath, { force: true });
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
    }
}

function boundsForCoordinates(
    coordinates: readonly LongitudeLatitude[]
): [number, number, number, number] {
    const longitudes = coordinates.map(([longitude]) => longitude);
    const latitudes = coordinates.map(([, latitude]) => latitude);
    return [
        Math.min(...longitudes),
        Math.min(...latitudes),
        Math.max(...longitudes),
        Math.max(...latitudes)
    ];
}

async function sha256File(filePath: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    return hash.digest('hex');
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
    const basePath = tifPath.replace(/\.tif$/i, '');
    const rgbVrtPath = `${basePath}-rgb.vrt`;
    const alphaVrtPath = `${basePath}-alpha.vrt`;
    const mbtilesPath = `${basePath}.mbtiles`;
    const nextMbtilesPath = `${basePath}.next.mbtiles`;
    const temporaryPaths = [rgbVrtPath, alphaVrtPath, nextMbtilesPath];

    const cutline = chartCutlineForFilename(tifPath);
    if (!cutline && /^(?:vfr-|ifr-)/.test(path.basename(tifPath).toLowerCase())) {
        throw new Error(`no reviewed chart cutline for ${path.basename(tifPath)}`);
    }
    if (await fileExists(mbtilesPath) && !force) {
        const receipt = await currentBuildReceipt(tifPath, mbtilesPath);
        if (receipt) {
            await Promise.all(temporaryPaths.map(filePath => fs.rm(filePath, { force: true })));
            console.log(`file "${mbtilesPath}" is current`);
            return receipt;
        }
        console.warn(`rebuilding stale or unverifiable chart cache "${mbtilesPath}"`);
    }

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
                '-cutline_srs', 'EPSG:4326',
                '-cutline', cutline,
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
        await Promise.all(temporaryPaths.map(filePath => fs.rm(filePath, { force: true })));
    }
}

export async function tileCharts(chartRoot: string, force = false): Promise<void> {
    await verifyGdalTools();
    const tiffs = await findTiffs(chartRoot);
    if (tiffs.length === 0) {
        console.log(`No chart TIFFs found under ${chartRoot}`);
        await writeChartManifests(chartRoot);
        return;
    }
    const verifiedReceipts = new Map<string, ChartBuildReceipt>();
    for (const tifPath of tiffs) {
        const receipt = await tileMbtilesFromTiff(tifPath, force);
        verifiedReceipts.set(path.resolve(tifPath.replace(/\.tif$/i, '.mbtiles')), receipt);
    }
    await writeChartManifestsWithReceipts(chartRoot, verifiedReceipts);
}
