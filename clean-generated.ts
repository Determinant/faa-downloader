#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireChartBuildLock } from './lib/chart-build-lock.ts';
import { migrateChartSources } from './lib/chart-source-layout.ts';
import { buildFingerprint } from './lib/build-cache.ts';
import { sha256File, writeFileAtomic } from './lib/fs-utils.ts';
import { linkLegacyPdfBooks, relocatedPdfVolumes, tppBookFiles } from './lib/pdf-layout.ts';
import { migrateNavSources, navSourceDirectory } from './lib/nav-source-layout.ts';
import { pruneGeneration, publishGeneration, stageJson } from './lib/publication.ts';
import { SUPPLEMENT_BUILDER_VERSION } from './lib/chart-supplements.ts';
import { extractZipEntry } from './lib/zip.ts';

type Artifact = { file: string; sha256: string; bytes?: number; byteLength?: number };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

async function readJson(file: string): Promise<any> {
    return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function exists(file: string): Promise<boolean> {
    try { await fs.access(file); return true; }
    catch (error: any) { if (error.code === 'ENOENT') return false; throw error; }
}

async function checkArtifact(directory: string, artifact: Artifact, hash = false): Promise<void> {
    if (path.basename(artifact.file) !== artifact.file) throw new Error(`Unsafe artifact path: ${artifact.file}`);
    const file = path.join(directory, artifact.file);
    const size = artifact.bytes ?? artifact.byteLength;
    if ((await fs.stat(file)).size !== size) throw new Error(`Artifact size mismatch: ${file}`);
    if (hash && await sha256File(file) !== artifact.sha256) throw new Error(`Artifact hash mismatch: ${file}`);
}

async function cleanNavigation(output: string, cycle: string): Promise<void> {
    const directory = path.join(output, 'charts', cycle, 'nav');
    const manifest = await readJson(path.join(directory, 'manifest.json'));
    const omitted = new Set(['vfr-waypoints', 'nasr-coverage', 'cifp-source']);
    const coverage = manifest.products.find((product: any) => product.id === 'nasr-coverage');
    const sourceDirectory = navSourceDirectory(output, cycle);
    if (coverage) {
        await checkArtifact(directory, coverage, true);
        await writeFileAtomic(path.join(sourceDirectory, 'coverage.json'),
            await fs.readFile(path.join(directory, coverage.file)));
    }
    manifest.products = manifest.products.filter((product: any) => !omitted.has(product.id));
    manifest.schemaVersion = 3;
    for (const product of manifest.products) await checkArtifact(directory, product, true);
    const fixes = manifest.products.find((product: any) => product.id === 'fixes');
    if (fixes && fixes.vfrWaypointCount === undefined) {
        const collection = await readJson(path.join(directory, fixes.file));
        if (!Array.isArray(collection.features) || collection.features.length !== fixes.count) {
            throw new Error(`Invalid fixes collection for ${cycle}`);
        }
        fixes.vfrWaypointCount = collection.features.filter((feature: any) =>
            feature.properties?.kind === 'vfr-waypoint').length;
    }
    await writeFileAtomic(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
    await pruneGeneration(directory, manifest.products.map((product: Artifact) => product.file));

    // A cached CIFP ZIP already holds the exact decoded record file. Keep one source copy.
    if (!await exists(sourceDirectory)) return;
    const zip = (await fs.readdir(sourceDirectory)).find(name => /^CIFP_\d{6}\.zip$/.test(name));
    const raw = path.join(sourceDirectory, 'FAACIFP18');
    if (zip) {
        try { await fs.access(raw); }
        catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
        const extracted = path.join(sourceDirectory, `.FAACIFP18.verify-${process.pid}`);
        try {
            await extractZipEntry(path.join(sourceDirectory, zip), 'FAACIFP18', extracted);
            if (await sha256File(extracted) !== await sha256File(raw)) {
                throw new Error(`CIFP ZIP and extracted record differ for ${cycle}`);
            }
            await fs.rm(raw);
        } finally { await fs.rm(extracted, { force: true }); }
    }
}

async function cleanProcedures(output: string, cycle: string): Promise<void> {
    const directory = path.join(output, 'charts', cycle, 'tpp');
    const release = await acquireChartBuildLock(path.join(output, 'charts', cycle, '.tpp'));
    try {
        const manifest = await readJson(path.join(directory, 'manifest.json'));
        await checkArtifact(directory, manifest, true);
        const catalog = await readJson(path.join(directory, manifest.file));
        const volumes = await relocatedPdfVolumes(directory, catalog.volumes);
        if (JSON.stringify(volumes) !== JSON.stringify(catalog.volumes)) {
            const updated = { ...catalog, volumes, generatedAt: new Date().toISOString() };
            const staging = await fs.mkdtemp(path.join(path.dirname(directory), '.tpp-relocate-'));
            try {
                const artifact = await stageJson(staging, 'catalog.json', updated);
                await publishGeneration(staging, directory, {
                    ...manifest, ...artifact, volumes, generatedAt: updated.generatedAt
                });
                await pruneGeneration(directory, [artifact.file, ...await tppBookFiles(directory)]);
            } finally { await fs.rm(staging, { recursive: true, force: true }); }
        } else await pruneGeneration(directory, [manifest.file, ...await tppBookFiles(directory)]);
    } finally { await release(); }
}

async function cleanSupplements(output: string, cycle: string): Promise<void> {
    const file = path.join(output, 'charts', cycle, 'cs', 'catalog.json');
    const release = await acquireChartBuildLock(path.join(output, 'charts', cycle, '.cs'));
    try {
        const catalog = await readJson(file);
        const volumes = await relocatedPdfVolumes(path.dirname(file), catalog.volumes);
        if (!('expected' in catalog) && catalog.builderVersion === SUPPLEMENT_BUILDER_VERSION &&
            catalog.schemaVersion === 3 && JSON.stringify(volumes) === JSON.stringify(catalog.volumes)) return;
        delete catalog.expected;
        catalog.volumes = volumes;
        catalog.schemaVersion = 3;
        catalog.builderVersion = SUPPLEMENT_BUILDER_VERSION;
        catalog.generatedAt = new Date().toISOString();
        const contents = `${JSON.stringify(catalog)}\n`;
        const inputSha256 = buildFingerprint({
            schemaVersion: catalog.schemaVersion, builderVersion: SUPPLEMENT_BUILDER_VERSION,
            revision: cycle, sourceXml: catalog.sourceXml,
            volumes: catalog.volumes.map(({ pageCount: _pageCount, ...volume }: any) => volume)
        });
        await writeFileAtomic(file, contents);
        await writeFileAtomic(path.join(output, 'supplements', `${cycle}.build.json`),
            `${JSON.stringify({ schemaVersion: 1, inputSha256, outputSha256: digest(contents) })}\n`);
    } finally { await release(); }
}

async function cleanPackages(output: string, cycle: string): Promise<void> {
    const directory = path.join(output, 'charts', cycle, 'mbtiles');
    const release = await acquireChartBuildLock(path.join(directory, 'packages'));
    try {
        const manifest = await readJson(path.join(directory, 'manifest.json'));
        const keep = new Set<string>();
        for (const archive of manifest.archives) {
            await checkArtifact(directory, archive);
            keep.add(archive.file);
        }
        for (const name of await fs.readdir(directory)) {
            if (/-[a-f0-9]{64}\.mbtiles$/.test(name) && !keep.has(name)) await fs.rm(path.join(directory, name));
        }
        const cache = path.join(output, 'mbtiles', cycle);
        const currentReceipt = `chart-packages-${buildFingerprint(path.relative(cache, directory)).slice(0, 16)}.build.json`;
        if (await exists(path.join(cache, currentReceipt))) {
            const current = await fs.readFile(path.join(cache, currentReceipt), 'utf8');
            for (const name of await fs.readdir(cache)) {
                if (name !== currentReceipt && /^chart-packages-[a-f0-9]{16}\.build\.json$/.test(name) &&
                    await fs.readFile(path.join(cache, name), 'utf8') === current) {
                    await fs.rm(path.join(cache, name));
                }
            }
        }
    } finally { await release(); }
}

async function cleanTerrain(output: string): Promise<void> {
    const directory = path.join(output, 'charts', 'terrain');
    const cache = path.join(output, 'terrain-cache');
    const release = await acquireChartBuildLock(cache);
    try {
        const manifest = await readJson(path.join(directory, 'manifest.json'));
        const keep = new Set<string>([manifest.provenance.file]);
        await checkArtifact(directory, manifest.provenance);
        for (const shard of manifest.shards) {
            await checkArtifact(directory, shard);
            keep.add(shard.file);
            const index = await readJson(path.join(directory, shard.file));
            for (const archive of index.archives) for (const artifact of [archive, archive.surface].filter(Boolean)) {
                await checkArtifact(directory, artifact);
                keep.add(artifact.file);
            }
        }
        for (const name of await fs.readdir(directory)) {
            if (/^[a-f0-9]{64}\.(?:dem|terrain|terrain-sources\.json)$/.test(name) && !keep.has(name)) {
                await fs.rm(path.join(directory, name));
            }
        }
        if (await exists(cache)) {
            for (const name of await fs.readdir(cache)) {
                if (/^\.work-[A-Za-z0-9]+$/.test(name)) await fs.rm(path.join(cache, name), { recursive: true, force: true });
            }
        }
    } finally { await release(); }
}

async function cleanObstacles(output: string): Promise<void> {
    const directory = path.join(output, 'charts', 'obstacles');
    const release = await acquireChartBuildLock(path.join(output, 'obstacles'));
    try {
        const manifest = await readJson(path.join(directory, 'manifest.json'));
        await checkArtifact(directory, { file: manifest.dataset.path, sha256: manifest.dataset.sha256,
            bytes: manifest.dataset.bytes }, true);
        for (const name of await fs.readdir(directory)) {
            if (name !== manifest.dataset.path && /^obstacles-[a-f0-9]{64}\.geojson\.gz$/.test(name)) {
                await fs.rm(path.join(directory, name));
            }
        }
    } finally { await release(); }
}

export async function cleanGenerated(output = 'dist'): Promise<void> {
    const root = path.resolve(output);
    const charts = path.join(root, 'charts');
    if (!await exists(charts)) return;
    const release = await acquireChartBuildLock(path.join(charts, '.navigation'));
    try {
        await migrateChartSources(charts);
        await migrateNavSources(root);
        await migratePdfBooks(root);
        const cycles = (await fs.readdir(charts, { withFileTypes: true }))
            .filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
            .map(entry => entry.name);
        for (const cycle of cycles) {
            const directory = path.join(charts, cycle);
            if (await exists(path.join(directory, 'nav', 'manifest.json'))) await cleanNavigation(root, cycle);
            if (await exists(path.join(directory, 'mbtiles', 'manifest.json'))) await cleanPackages(root, cycle);
        }
        if (await exists(path.join(charts, 'terrain', 'manifest.json'))) await cleanTerrain(root);
        if (await exists(path.join(charts, 'obstacles', 'manifest.json'))) await cleanObstacles(root);
    } finally { await release(); }
}

/** Migrate PDF books and their catalog references as one resumable operation. */
export async function migratePdfBooks(output = 'dist'): Promise<void> {
    const root = path.resolve(output);
    const charts = path.join(root, 'charts');
    if (!await exists(charts)) return;
    const oldPdfBooks = await linkLegacyPdfBooks(charts);
    const cycles = (await fs.readdir(charts, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
        .map(entry => entry.name);
    for (const cycle of cycles) {
        const directory = path.join(charts, cycle);
        if (await exists(path.join(directory, 'tpp', 'manifest.json'))) await cleanProcedures(root, cycle);
        if (await exists(path.join(directory, 'cs', 'catalog.json'))) await cleanSupplements(root, cycle);
    }
    for (const file of oldPdfBooks) await fs.rm(file);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const argument = process.argv.slice(2);
    if (argument.length > 1 || (argument[0] && !argument[0].startsWith('--output='))) {
        throw new Error('Usage: npm run clean:generated -- [--output=dist]');
    }
    await cleanGenerated(argument[0]?.slice('--output='.length));
}
