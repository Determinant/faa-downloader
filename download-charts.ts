#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildProcedureCatalog } from './build-procedures.ts';
import { buildNasrData } from './download-nasr.ts';
import {
    discoverCharts,
    type ChartCandidate,
    type ChartGroup,
    type UnzipMap
} from './lib/chart-discovery.ts';
import {
    DEFAULT_DOWNLOAD_CONCURRENCY,
    mapWithConcurrency,
    parseDownloadConcurrency
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
};

type ChartDownload = {
    group: ChartGroup;
    region: string;
    candidate: ChartCandidate;
    localPath: string;
};

function parseArgs(argv: string[]): Options {
    const options: Options = {
        output: DEFAULT_OUTPUT,
        help: false,
        force: false,
        concurrency: DEFAULT_DOWNLOAD_CONCURRENCY
    };

    for (const arg of argv) {
        if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else if (arg.startsWith('--output=')) {
            options.output = arg.slice('--output='.length);
        } else if (arg.startsWith('--tile=')) {
            options.tile = arg.slice('--tile='.length);
        } else if (arg === '--force') {
            options.force = true;
        } else if (arg.startsWith('--concurrency=')) {
            options.concurrency = parseDownloadConcurrency(
                arg.slice('--concurrency='.length),
                '--concurrency'
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
    return options;
}

function printHelp(): void {
    console.log(`Usage: node --import=tsx download-charts.ts [options]

Downloads current FAA charts, produces WebP MBTiles, and builds navigation metadata.

Options:
  --output=DIR     Build root (default: dist)
  --tile=FILE      Convert one existing TIFF to WebP MBTiles
  --force          Rebuild existing MBTiles atomically
  --concurrency=N  Parallel downloads, 1-16 (default: ${DEFAULT_DOWNLOAD_CONCURRENCY})
  --help, -h       Show this help

Output layout:
  DIR/charts/      PDFs, GeoTIFFs, and MBTiles grouped by publication date
  DIR/zips/        Downloaded source ZIP archives grouped by publication date
  DIR/charts/YYYY-MM-DD/nav/   Normalized NASR map data
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
    group: ChartGroup,
    region: string,
    unzip: UnzipMap
): Promise<void> {
    const chartPrefix = `${group.prefix}-${region.toLowerCase()}`;

    console.log(`extracting "${archivePath}"`);
    const entries = await listZipEntries(archivePath);
    for (const [sourceName, suffix] of Object.entries(unzip)) {
        const matches = entries.filter(entry => normalizeArchivePath(entry) === sourceName);
        if (matches.length !== 1) {
            throw new Error(
                `${path.basename(archivePath)} contains ${matches.length} entries for ${sourceName}`
            );
        }
        const chartFilePath = path.join(chartRoot, date, `${chartPrefix}${suffix}`);
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
            const extension = candidate.unzip ? 'zip' : 'pdf';
            const destinationRoot = candidate.unzip ? downloadRoot : chartRoot;
            downloads.push({
                group,
                region,
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
    const acquired = await mapWithConcurrency(
        downloads,
        options.concurrency,
        async download => {
            await downloadFile(download.candidate.url, download.localPath, {
                userAgent: 'faa-regs-chart-builder/1.0',
                validate: validateChartDownload
            });
            return download;
        }
    );
    const archives = acquired.flatMap(download => (
        download.candidate.unzip
            ? [{ ...download, unzip: download.candidate.unzip }]
            : []
    ));
    await mapWithConcurrency(archives, options.concurrency, async archive => {
        await extractChart(
            archive.localPath,
            chartRoot,
            archive.candidate.date,
            archive.group,
            archive.region,
            archive.unzip
        );
    });

    await tileCharts(chartRoot, options.force);
    await buildNasrData({ output: options.output, concurrency: options.concurrency });
    await buildProcedureCatalog({ output: options.output });
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
