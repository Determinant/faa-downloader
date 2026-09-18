#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildProcedureCatalog } from './build-procedures.ts';
import { buildChartSupplements } from './build-chart-supplements.ts';
import { buildChartPackages, readOfflineRegions } from './build-chart-packages.ts';
import { buildNasrData } from './download-nasr.ts';
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

Downloads current FAA charts, produces spatial/zoom WebP MBTiles, and builds navigation metadata.

Options:
  --output=DIR          Build root (default: dist)
  --tile=FILE           Convert one TIFF into the chart build cache
  --force               Rebuild MBTiles, packages, and Chart Supplement indexes
  --concurrency=N       Parallel downloads, 1-16 (default: ${DEFAULT_DOWNLOAD_CONCURRENCY})
  --tile-concurrency=N  Parallel MBTiles builds, 1-16 (default: ${DEFAULT_TILE_CONCURRENCY})
  --regions=FILE        Optional named offline region bounds (JSON)
  --help, -h            Show this help

Output layout:
  DIR/charts/      Original PDFs and GeoTIFFs grouped by publication date
  DIR/zips/        Downloaded source ZIP archives grouped by publication date
  DIR/mbtiles/YYYY-MM-DD/        Intermediate sheet MBTiles, receipts, and chart-manifest.json
  DIR/charts/YYYY-MM-DD/mbtiles/ Spatial/zoom delivery archives and manifest.json
  DIR/charts/YYYY-MM-DD/nav/   NASR map data, preferred/TEC routes, and historical filed routes
  DIR/charts/YYYY-MM-DD/nasr/  Downloaded NASR CSV ZIP archives
  DIR/charts/YYYY-MM-DD/tpp/   Airport/procedure catalog and PDF page index

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
        const chartFilePath = path.join(chartRoot, date, filename);
        await extractZipEntry(archivePath, matches[0], chartFilePath);
    }
}

function createDownloadPlan(
    groups: ChartGroup[],
    chartRoot: string,
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
            const destinationRoot = candidate.extractions ? downloadRoot : chartRoot;
            downloads.push({
                candidate,
                localPath: path.join(
                    destinationRoot,
                    candidate.date,
                    `${group.prefix}-${region.toLowerCase()}.${extension}`
                )
            });
        }
    }
    return downloads;
}

async function buildCharts(options: Options): Promise<void> {
    const outputRoot = path.resolve(options.output);
    const chartRoot = path.join(outputRoot, 'charts');
    const downloadRoot = path.join(outputRoot, 'zips');

    await fs.mkdir(chartRoot, { recursive: true });
    await fs.mkdir(downloadRoot, { recursive: true });

    const downloads = createDownloadPlan(
        await discoverCharts(),
        chartRoot,
        downloadRoot
    );

    console.log(`Acquiring ${downloads.length} chart files with concurrency ${options.concurrency}`);
    await mapWithConcurrency(
        downloads,
        options.concurrency,
        async download => {
            await downloadFile(download.candidate.url, download.localPath, {
                userAgent: 'faa-regs-chart-builder/1.0',
                validate: validateChartDownload
            });
            if (download.candidate.extractions) {
                await extractChart(
                    download.localPath,
                    chartRoot,
                    download.candidate.date,
                    download.candidate.extractions
                );
            }
        }
    );

    await tileCharts(chartRoot, options.force, options.tileConcurrency);
    await buildChartPackages(options.output, options.regions, options.force);
    await buildNasrData({ output: options.output, concurrency: options.concurrency });
    const procedures = await buildProcedureCatalog({ output: options.output });
    await buildChartSupplements({ output: options.output, effectiveDate: procedures.effectiveDate, force: options.force });
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
