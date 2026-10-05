#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireChartBuildLock } from './lib/chart-build-lock.ts';
import { sha256File } from './lib/fs-utils.ts';
import { buildFingerprint, matchesFile, readCachedJson, writeCachedJson } from './lib/build-cache.ts';
import { InvalidDownloadError } from './lib/download-validation.ts';
import { downloadFile } from './lib/http-download.ts';
import { writeObstacleGeoJson } from './lib/obstacles.ts';
import { extractZipEntry, listZipEntries, validateZipArchive } from './lib/zip.ts';

export const DAILY_DOF_URL = 'https://aeronav.faa.gov/Obst_Data/DAILY_DOF_CSV.ZIP';
const USER_AGENT = 'faa-regs-obstacle-builder/1.0';
const OBSTACLE_BUILDER_VERSION = 1;
type ObstacleManifest = {
    schemaVersion: number; generatedAt: string; source: Record<string, string>; horizontalDatum: string;
    dataset: Awaited<ReturnType<typeof writeObstacleGeoJson>> & {
        path: string; format: string; compression: string; sha256: string; bytes: number
    };
};

type BuildOptions = {
    output: string; sourceFile?: string; fetch?: typeof globalThis.fetch;
    /** Consume verified bytes while the lock prevents another build from pruning this snapshot. */
    onSnapshot?: (manifest: ObstacleManifest, file: string) => Promise<void>;
};

export async function buildObstacles(options: BuildOptions) {
    const outputRoot = path.resolve(options.output);
    const chartRoot = path.join(outputRoot, 'charts');
    const cache = path.join(outputRoot, 'obstacles');
    await fs.mkdir(chartRoot, { recursive: true });
    const release = await acquireChartBuildLock(cache);
    let work: string;
    try {
        work = await fs.mkdtemp(path.join(chartRoot, '.obstacles-'));
        const staged = path.join(work, 'publish');
        await fs.mkdir(staged, { mode: 0o755 });
        const csv = path.join(work, 'DOF.CSV');
        const validate = async (file: string) => {
            await validateZipArchive(file);
            const entries = await listZipEntries(file);
            if (entries.filter(entry => entry === 'DOF.CSV').length !== 1) {
                throw new InvalidDownloadError('Daily DOF ZIP must contain exactly one DOF.CSV');
            }
        };
        const source: Record<string, string> = {
            name: 'FAA Daily Digital Obstacle File',
            url: 'https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/dailydof/',
            downloadUrl: DAILY_DOF_URL,
            encoding: 'windows-1252'
        };
        let archive: string;
        if (options.sourceFile) {
            archive = path.resolve(options.sourceFile);
            source.filename = path.basename(archive);
        } else {
            const fetcher = options.fetch ?? globalThis.fetch;
            const response = await fetcher(DAILY_DOF_URL, { method: 'HEAD',
                headers: { 'user-agent': USER_AGENT, 'cache-control': 'no-cache' },
                signal: AbortSignal.timeout(120_000) });
            if (!response.ok) throw new Error(`Daily DOF source request failed (${response.status})`);
            const etag = response.headers.get('etag');
            const modified = response.headers.get('last-modified');
            if (!/^"[^"]*"$/.test(etag ?? '') || !modified || !Number.isFinite(Date.parse(modified))) {
                throw new Error('Daily DOF source is missing valid strong ETag/Last-Modified metadata');
            }
            source.etag = etag;
            source.lastModified = new Date(modified).toISOString();
            const key = createHash('sha256').update(etag).digest('hex');
            archive = path.join(cache, `${key}.zip`);
            await downloadFile(DAILY_DOF_URL, archive, {
                userAgent: USER_AGENT,
                // Pin downloads and resumed transfers to the version checked above.
                fetch: (url, init) => {
                    const headers = new Headers(init?.headers);
                    headers.set('if-match', etag);
                    headers.set('cache-control', 'no-cache');
                    return fetcher(url, { ...init, headers });
                },
                validate, validationKey: 'daily-dof-zip-v1'
            });
        }
        source.sha256 = await sha256File(archive);
        const published = path.join(chartRoot, 'obstacles');
        const manifestFile = path.join(published, 'manifest.json');
        const receipt = path.join(cache, 'manifest.build.json');
        const inputSha256 = buildFingerprint({ builder: OBSTACLE_BUILDER_VERSION, source });
        const cached = await readCachedJson<ObstacleManifest>(manifestFile, receipt, inputSha256);
        if (cached && path.basename(cached.dataset.path) === cached.dataset.path &&
            await matchesFile(path.join(published, cached.dataset.path), cached.dataset)) {
            console.log('Daily obstacles are already current');
            await options.onSnapshot?.(cached, path.join(published, cached.dataset.path));
            return cached;
        }
        if (options.sourceFile) await validate(archive);
        await extractZipEntry(archive, 'DOF.CSV', csv);
        const compressed = path.join(staged, 'obstacles.geojson.gz');
        const stats = await writeObstacleGeoJson(csv, compressed);
        const sha256 = await sha256File(compressed);
        const filename = `obstacles-${sha256}.geojson.gz`;
        const bytes = (await fs.stat(compressed)).size;
        await fs.rename(compressed, path.join(staged, filename));
        const manifest: ObstacleManifest = {
            schemaVersion: 1, generatedAt: new Date().toISOString(), source,
            horizontalDatum: 'WGS84',
            dataset: { path: filename, format: 'geojson', compression: 'gzip', sha256, bytes, ...stats }
        };
        await fs.mkdir(published, { recursive: true, mode: 0o755 });
        const destination = path.join(published, filename);
        try {
            await fs.link(path.join(staged, filename), destination);
        } catch (error: any) {
            if (error.code !== 'EEXIST') throw error;
            if (await sha256File(destination) !== sha256) {
                throw new Error(`Published obstacle snapshot is corrupt: ${filename}`);
            }
        }
        await writeCachedJson(manifestFile, receipt, inputSha256, manifest);
        for (const name of await fs.readdir(published)) {
            if (name !== filename && /^obstacles-[a-f0-9]{64}\.geojson\.gz$/.test(name)) {
                await fs.rm(path.join(published, name));
            }
        }

        // Keep the successful online snapshot; local builds leave the download cache alone.
        if (!options.sourceFile) {
            for (const name of await fs.readdir(cache)) {
                const match = name.match(/^([a-f0-9]{64}\.zip)(?:\.http\.json|\.part(?:\.http\.json)?)?$/);
                if (match && match[1] !== path.basename(archive)) await fs.rm(path.join(cache, name));
            }
        }
        console.log(`Daily obstacles: ${stats.count} records (${stats.unverifiedCount} unverified), `
            + `${(bytes / 1_000_000).toFixed(1)} MB gzip; source ${source.lastModified ?? 'local ZIP (date unknown)'}`);
        await options.onSnapshot?.(manifest, destination);
        return manifest;
    } finally {
        try { if (work) await fs.rm(work, { recursive: true, force: true }); }
        finally { await release(); }
    }
}

async function main() {
    const options: BuildOptions = { output: 'dist' };
    for (const arg of process.argv.slice(2)) {
        if (arg === '--help' || arg === '-h') {
            console.log(`Usage: node --import=tsx build-obstacles.ts [options]

Builds the FAA's full daily obstacle snapshot, independent of the chart cycle.

  --output=DIR   Build root (default: dist)
  --source=FILE  Local DAILY_DOF_CSV.ZIP; no network requests
  --help, -h     Show this help

Publishes DIR/charts/obstacles/manifest.json and compressed GeoJSON.
Online builds check source freshness and cache ZIPs under DIR/obstacles/.`);
            return;
        }
        if (arg.startsWith('--output=')) options.output = arg.slice('--output='.length);
        else if (arg.startsWith('--source=')) options.sourceFile = arg.slice('--source='.length);
        else throw new Error(`Unknown option: ${arg}`);
    }
    if (!options.output.trim()) throw new Error('--output must not be empty');
    if (options.sourceFile !== undefined && !options.sourceFile.trim()) throw new Error('--source must not be empty');
    await buildObstacles(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
