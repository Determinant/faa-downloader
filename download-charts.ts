#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { faaEffectiveDate } from './lib/faa-effective-date.ts';
import { pdfBookFolder } from './lib/pdf-layout.ts';
import { acquireChartBuildLock } from './lib/chart-build-lock.ts';
import { migratePdfBooks } from './clean-generated.ts';
import { prepareProcedureCatalog } from './build-procedures.ts';
import { buildChartSupplements } from './build-chart-supplements.ts';
import { buildChartPackages, readOfflineRegions } from './build-chart-packages.ts';
import { buildNasrData } from './download-nasr.ts';
import { buildObstacles } from './build-obstacles.ts';
import { buildChartCycles } from './build-chart-cycles.ts';
import {
    discoverCharts,
    type ChartCandidate,
    type ChartExtraction,
    type ChartGroup
} from './lib/chart-discovery.ts';
import {
    DEFAULT_DOWNLOAD_CONCURRENCY,
    DEFAULT_TILE_CONCURRENCY,
    mapWithConcurrency,
    parseConcurrency
} from './lib/concurrency.ts';
import {
    tileCharts,
    tileMbtilesFromTiff,
    verifyGdalTools
} from './lib/chart-tiler.ts';
import { downloadFile } from './lib/http-download.ts';
import { validatePdfFile } from './lib/pdf.ts';
import { extractZipEntry, listZipEntries, validateZipArchive } from './lib/zip.ts';
import { chartCyclePaths } from './lib/chart-paths.ts';
import { migrateChartSources } from './lib/chart-source-layout.ts';

export { chartCutlineForFilename, tileMbtilesFromTiff } from './lib/chart-tiler.ts';

const DEFAULT_OUTPUT = 'dist';

type Options = {
    output: string;
    help: boolean;
    tile?: string;
    force: boolean;
    concurrency: number;
    tileConcurrency: number;
    regions?: string;
};

type ChartDownload = {
    candidate: ChartCandidate;
    localPath: string;
};

function parseArgs(argv: string[]): Options {
    const options: Options = {
        output: DEFAULT_OUTPUT,
        help: false,
        force: false,
        concurrency: DEFAULT_DOWNLOAD_CONCURRENCY,
        tileConcurrency: DEFAULT_TILE_CONCURRENCY
    };

    for (const arg of argv) {
        if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else if (arg.startsWith('--output=')) {
            options.output = arg.slice('--output='.length);
        } else if (arg.startsWith('--tile=')) {
            options.tile = arg.slice('--tile='.length);
        } else if (arg.startsWith('--regions=')) {
            options.regions = arg.slice('--regions='.length);
        } else if (arg === '--force') {
            options.force = true;
        } else if (arg.startsWith('--concurrency=')) {
            options.concurrency = parseConcurrency(
                arg.slice('--concurrency='.length),
                '--concurrency'
            );
        } else if (arg.startsWith('--tile-concurrency=')) {
            options.tileConcurrency = parseConcurrency(
                arg.slice('--tile-concurrency='.length),
                '--tile-concurrency'
            );
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    if (!options.output.trim()) {
        throw new Error('--output must not be empty');
    }
    if (options.tile !== undefined && !options.tile.trim()) {
        throw new Error('--tile must not be empty');
    }
    if (options.regions !== undefined && !options.regions.trim()) throw new Error('--regions must not be empty');
    return options;
}

function printHelp(): void {
    console.log(`Usage: node --import=tsx download-charts.ts [options]

Downloads current FAA charts, produces spatial/zoom WebP MBTiles, and builds navigation metadata
including the NOAA WMM geographic magnetic variation model and FAA daily obstacles.

Options:
  --output=DIR          Build root (default: dist)
  --tile=FILE           Convert one TIFF into the chart build cache
  --force               Rebuild MBTiles, packages, and Chart Supplement indexes
  --concurrency=N       Parallel downloads, 1-16 (default: ${DEFAULT_DOWNLOAD_CONCURRENCY})
  --tile-concurrency=N  Parallel MBTiles builds, 1-16 (default: ${DEFAULT_TILE_CONCURRENCY})
  --regions=FILE        Optional named offline region bounds (JSON)
  --help, -h            Show this help

Output layout:
  DIR/charts/      Published PDFs and data grouped by publication date
  DIR/sources/YYYY-MM-DD/charts/ Extracted source GeoTIFFs
  DIR/sources/YYYY-MM-DD/{tpp,cs}/ Revalidated source PDFs
  DIR/zips/        Downloaded source ZIP archives grouped by publication date
  DIR/mbtiles/YYYY-MM-DD/        Intermediate sheet MBTiles, receipts, and chart-manifest.json
  DIR/charts/YYYY-MM-DD/mbtiles/ Spatial/zoom delivery archives and manifest.json
  DIR/charts/YYYY-MM-DD/nav/   NASR map data, routes, and geographic magnetic model
  DIR/sources/YYYY-MM-DD/nav/  Reusable FAA navigation source inputs
  DIR/charts/YYYY-MM-DD/tpp/   TPP books, airport/procedure catalog, and PDF page index
  DIR/charts/YYYY-MM-DD/cs/    Chart Supplement books and airport page catalog
  DIR/charts/obstacles/       Daily obstacle GeoJSON and source metadata

Example:
  npm run build:charts
`);
}

function normalizeArchivePath(value: string): string {
    return value.replaceAll('\\', '/').replaceAll(' ', '_').replace(/^\/+/, '');
}

async function validateChartDownload(filePath: string, destination: string): Promise<void> {
    const extension = path.extname(destination).toLowerCase();
    if (extension === '.zip') {
        await validateZipArchive(filePath);
        return;
    }
    if (extension === '.pdf') {
        await validatePdfFile(filePath);
        return;
    }
    throw new Error(`Unsupported chart download type: ${destination}`);
}

async function extractChart(
    archivePath: string,
    chartRoot: string,
    date: string,
    extractions: ChartExtraction[]
): Promise<void> {
    console.log(`extracting "${archivePath}"`);
    const entries = await listZipEntries(archivePath);
    for (const { sourceName, filename } of extractions) {
        if (path.basename(filename) !== filename || !filename.endsWith('.tif')) {
            throw new Error(`Unsafe chart extraction filename: ${filename}`);
        }
        const matches = entries.filter(entry => normalizeArchivePath(entry) === sourceName);
        if (matches.length !== 1) {
            throw new Error(
                `${path.basename(archivePath)} contains ${matches.length} entries for ${sourceName}`
            );
        }
        const chartFilePath = path.join(chartCyclePaths(path.dirname(chartRoot), date).sourceDirectory, filename);
        await extractZipEntry(archivePath, matches[0], chartFilePath);
    }
}

function createDownloadPlan(
    groups: ChartGroup[],
    sourceRoot: string,
    downloadRoot: string
): ChartDownload[] {
    const downloads: ChartDownload[] = [];
    for (const group of groups) {
        for (const [region, listing] of Object.entries(group.files)) {
            const candidate = listing.current;
            if (!candidate) {
                console.warn(`no current chart found for ${group.prefix}/${region}`);
                continue;
            }
            const extension = candidate.extractions ? 'zip' : 'pdf';
            const destinationRoot = candidate.extractions ? downloadRoot : sourceRoot;
            const filename = `${group.prefix}-${region.toLowerCase()}.${extension}`;
            const folder = extension === 'pdf' ? pdfBookFolder(filename) : undefined;
            if (extension === 'pdf' && !folder) throw new Error(`Unrecognized PDF chart family: ${filename}`);
            downloads.push({
                candidate,
                localPath: path.join(
                    destinationRoot,
                    candidate.date,
                    ...(folder ? [folder] : []),
                    filename
                )
            });
        }
    }
    return downloads;
}

export async function downloadChartFiles(
    groups: ChartGroup[], output: string, concurrency = DEFAULT_DOWNLOAD_CONCURRENCY
): Promise<void> {
    const outputRoot = path.resolve(output);
    const chartRoot = path.join(outputRoot, 'charts');
    const downloadRoot = path.join(outputRoot, 'zips');
    await fs.mkdir(chartRoot, { recursive: true });
    await fs.mkdir(downloadRoot, { recursive: true });
    const downloads = createDownloadPlan(groups, path.join(outputRoot, 'sources'), downloadRoot);
    console.log(`Acquiring ${downloads.length} chart files with concurrency ${concurrency}`);
    await mapWithConcurrency(downloads, concurrency, async download => {
        const release = await acquireChartBuildLock(download.localPath);
        try {
            if (!download.candidate.extractions) {
                const filename = path.basename(download.localPath);
                const legacy = path.join(chartRoot, download.candidate.date, pdfBookFolder(filename)!, filename);
                // Seed existing validators without another full transfer. downloadFile
                // replaces sources by rename; it never writes through this legacy link.
                try { await fs.link(legacy, download.localPath); }
                catch (error: any) { if (!['EEXIST', 'ENOENT'].includes(error.code)) throw error; }
            }
            await downloadFile(download.candidate.url, download.localPath, {
                userAgent: 'faa-regs-chart-builder/1.0', validate: validateChartDownload, revalidate: true,
                metadataFile: path.join(outputRoot, 'sources', download.candidate.date, `${path.basename(download.localPath)}.http.json`)
            });
            if (download.candidate.extractions) {
                await extractChart(download.localPath, chartRoot, download.candidate.date, download.candidate.extractions);
            }
        } finally { await release(); }
    });
}

export async function buildCharts(options: Options): Promise<void> {
    // Select every cycle-dependent feed at the same 0901Z cutoff, even across a cycle boundary.
    const today = faaEffectiveDate();
    const outputRoot = path.resolve(options.output);
    const chartRoot = path.join(outputRoot, 'charts');
    const downloadRoot = path.join(outputRoot, 'zips');

    // Pin and validate the XML before downloads/tiling can span an FAA rollover.
    const preparedProcedures = await prepareProcedureCatalog({ output: outputRoot, today });

    await fs.mkdir(chartRoot, { recursive: true });
    await fs.mkdir(downloadRoot, { recursive: true });
    await migratePdfBooks(outputRoot);
    await migrateChartSources(chartRoot);

    await downloadChartFiles(await discoverCharts({ today }), outputRoot, options.concurrency);

    await tileCharts(chartRoot, options.force, options.tileConcurrency);
    await buildChartPackages(options.output, options.regions, options.force);
    await buildNasrData({ output: options.output, concurrency: options.concurrency, today });
    const procedures = await preparedProcedures.build();
    await buildChartSupplements({ output: options.output, effectiveDate: procedures.effectiveDate, force: options.force });
    await buildObstacles({ output: options.output });
    await buildChartCycles(options.output);
    console.log(`Charts are ready under ${chartRoot}`);
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        printHelp();
    } else if (options.tile) {
        await verifyGdalTools();
        await tileMbtilesFromTiff(path.resolve(options.tile), options.force);
    } else {
        // Reject a bad region file before starting lengthy downloads or GDAL work.
        await readOfflineRegions(options.regions);
        await buildCharts(options);
    }
}

const entryPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entryPath) {
    main().catch(error => {
        console.error('❌ Error:', error);
        process.exitCode = 1;
    });
}
