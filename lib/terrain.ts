import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { acquireChartBuildLock } from './chart-build-lock.ts';
import { buildFingerprint, readCachedJson, writeCachedJson } from './build-cache.ts';
import { loadTerrainInputs, USGS_TERRAIN_SOURCE } from './terrain-source.ts';
import { intersects, renderTerrainBatch, terrainBatchBounds, terrainBatches, terrainGdalVersion } from './terrain-raster.ts';
import { sha256File, writeFileAtomic } from './fs-utils.ts';
import { TERRAIN_MAX_ZOOM, TERRAIN_RESOLUTION_ARC_SECONDS, terrainGridSize, terrainRegionBlocks } from './terrain-grid.ts';
import { missingTerrainGrid, reduceTerrainArchive } from './terrain-overviews.ts';
import { validateRegions, type OfflineRegionDefinition } from './chart-packager.ts';

// Bump when raster processing or packaging semantics change, independently of the delivery format.
const TERRAIN_BUILD_VERSION = 5;
// Finest-level GDAL processing is unchanged, so existing native batches remain reusable.
const TERRAIN_RASTER_BUILD_VERSION = 4;
export type TerrainArchive = { zoom: number; x: number; y: number; file: string; sha256: string; byteLength: number };
export type TerrainManifest = {
    schemaVersion: 2; encoding: 'int16-metres-gzip'; grid: 'EPSG:4326'; resolutionArcSeconds: 4.9; minZoom: 1; maxZoom: 10; generatedAt: string;
    source: string; attribution: string; shards: TerrainArchive[];
    verticalDatum: string; provenance: { file: string; sha256: string; byteLength: number };
};
const shardKey = (a: Pick<TerrainArchive, 'zoom' | 'x' | 'y'>) => `${a.zoom}/${Math.floor(a.x / 64) * 64}/${Math.floor(a.y / 64) * 64}`;
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const archiveKey = (a: Pick<TerrainArchive, 'zoom' | 'x' | 'y'>) => `${a.zoom}/${a.x}/${a.y}`;

export function terrainBlocks(regions: OfflineRegionDefinition[]): Array<{ zoom: number; x: number; y: number }> {
    validateRegions(regions);
    return terrainRegionBlocks(regions);
}

export function encodeTerrainArchive(zoom: number, x: number, y: number, grids: Uint8Array[]): Buffer {
    if (!Number.isInteger(zoom) || zoom < 1 || zoom > TERRAIN_MAX_ZOOM || !Number.isInteger(x) || !Number.isInteger(y) ||
        x < 0 || y < 0 || x % 2 || y % 2 || x >= terrainGridSize(zoom).columns || y >= terrainGridSize(zoom).rows ||
        grids.length !== 4 || grids.some(grid => grid.byteLength !== 256 * 256 * 2)) throw new Error('Invalid terrain block');
    const parts = grids.map(grid => gzipSync(grid));
    const header = Buffer.alloc(56);
    header.write('ZDEM0002'); header.writeUInt32LE(zoom, 8); header.writeUInt32LE(x, 12);
    header.writeUInt32LE(y, 16); header.writeUInt32LE(4, 20);
    let offset = header.length;
    parts.forEach((part, index) => {
        header.writeUInt32LE(offset, 24 + index * 8); header.writeUInt32LE(part.length, 28 + index * 8);
        offset += part.length;
    });
    if (offset > 2 * 1024 * 1024) throw new Error('Terrain archive exceeds size bound');
    return Buffer.concat([header, ...parts]);
}

function validArchive(value: any): value is TerrainArchive {
    return value && Number.isInteger(value.zoom) && value.zoom >= 1 && value.zoom <= TERRAIN_MAX_ZOOM &&
        Number.isInteger(value.x) && value.x >= 0 && value.x % 2 === 0 && value.x < terrainGridSize(value.zoom).columns &&
        Number.isInteger(value.y) && value.y >= 0 && value.y % 2 === 0 && value.y < terrainGridSize(value.zoom).rows &&
        /^[a-f0-9]{64}$/.test(value.sha256) && value.file === `${value.sha256}.dem` &&
        Number.isSafeInteger(value.byteLength) && value.byteLength > 56 && value.byteLength <= 2 * 1024 * 1024;
}

async function verifyArchive(directory: string, archive: TerrainArchive): Promise<boolean> {
    try {
        const file = path.join(directory, archive.file);
        return (await fs.stat(file)).size === archive.byteLength && await sha256File(file) === archive.sha256;
    } catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
}

export async function buildTerrain(output: string, regions: OfflineRegionDefinition[], options: {
    sourceDirectory?: string; rebuild?: boolean; fetch?: typeof globalThis.fetch; logger?: Pick<Console, 'log' | 'warn'>;
} = {}): Promise<TerrainManifest> {
    const blocks = terrainBlocks(regions);
    if (!blocks.length) throw new Error('Terrain regions are empty');
    const directory = path.resolve(output, 'charts/terrain'), cache = path.resolve(output, 'terrain-cache');
    const logger = options.logger ?? console;
    await fs.mkdir(directory, { recursive: true });
    await fs.mkdir(cache, { recursive: true });
    const release = await acquireChartBuildLock(cache);
    let work: string | undefined;
    try {
        const gdal = await terrainGdalVersion();
        const inputs = await loadTerrainInputs(regions, cache, options);
        work = await fs.mkdtemp(path.join(cache, '.work-'));
        const archives: TerrainArchive[] = [];
        const batches = terrainBatches(blocks).sort((a, b) => b.zoom - a.zoom || a.x - b.x || a.y - b.y);
        const available = new Map<string, TerrainArchive>();
        logger.log(`Terrain: ${batches.length} batches; building 4.9-arc-second grids first, then maximum-elevation overviews`);
        let rebuilt = 0;
        for (const [index, batch] of batches.entries()) {
            // Include a two-cell halo for source dependency tracking.
            const bounds = terrainBatchBounds(batch, 2);
            const native = batch.zoom === TERRAIN_MAX_ZOOM;
            const sources = native ? inputs.filter(input => intersects(input.bounds, bounds)) : [];
            const children = native ? [] : batch.blocks.flatMap(block => Array.from({ length: 4 }, (_, i) =>
                available.get(archiveKey({ zoom: block.zoom + 1, x: block.x * 2 + (i % 2) * 2,
                    y: block.y * 2 + Math.floor(i / 2) * 2 }))));
            const inputSha256 = native ? buildFingerprint({ version: TERRAIN_RASTER_BUILD_VERSION, gdal, batch,
                sources: sources.map(source => ({ id: source.id, sha256: source.sha256, bounds: source.bounds })) }) :
                buildFingerprint({ version: TERRAIN_BUILD_VERSION, batch, children: children.map(child => child?.sha256 ?? null) });
            const record = path.join(cache, 'batches', `${batch.zoom}/${batch.x}/${batch.y}.json`);
            const receipt = `${record}.build.json`;
            const previous = options.rebuild ? undefined : await readCachedJson<TerrainArchive[]>(record, receipt, inputSha256);
            let reusable = Array.isArray(previous) && previous.length === batch.blocks.length && previous.every((a, i) =>
                validArchive(a) && a.zoom === batch.blocks[i].zoom && a.x === batch.blocks[i].x && a.y === batch.blocks[i].y);
            if (reusable) for (const archive of previous!) {
                if (!await verifyArchive(directory, archive)) { reusable = false; break; }
            }
            let completed: TerrainArchive[];
            if (reusable) completed = previous!;
            else {
                const label = `Terrain: batch ${index + 1}/${batches.length}, level ${batch.zoom}`;
                logger.log(`${label}: ${native ? `rendering ${sources.length} source rasters` : 'reducing child archives'}`);
                const started = Date.now();
                const progress = setInterval(() => logger.log(`${label}: still processing (${Math.round((Date.now() - started) / 1000)}s)`), 30_000);
                progress.unref();
                let grids: Buffer[];
                try {
                    if (native) grids = await renderTerrainBatch(batch, sources.map(source => source.file), work);
                    else {
                        grids = [];
                        for (const child of children) grids.push(child ?
                            reduceTerrainArchive(await fs.readFile(path.join(directory, child.file))) : missingTerrainGrid());
                    }
                } finally { clearInterval(progress); }
                const generated: TerrainArchive[] = [];
                for (const [i, block] of batch.blocks.entries()) {
                    const bytes = encodeTerrainArchive(block.zoom, block.x, block.y, grids.slice(i * 4, i * 4 + 4));
                    const sha256 = digest(bytes), file = `${sha256}.dem`;
                    await writeFileAtomic(path.join(directory, file), bytes);
                    generated.push({ ...block, file, sha256, byteLength: bytes.length });
                }
                // Checkpoint completed batches before starting the next one; publication is separate.
                await writeCachedJson(record, receipt, inputSha256, generated);
                completed = generated; rebuilt++;
                logger.log(`${label}: complete (${((Date.now() - started) / 1000).toFixed(1)}s)`);
            }
            archives.push(...completed);
            for (const archive of completed) available.set(archiveKey(archive), archive);
            if (reusable && ((index + 1) % 100 === 0 || index + 1 === batches.length)) {
                logger.log(`Terrain: ${index + 1}/${batches.length} batches checked`);
            }
        }
        const groups = new Map<string, TerrainArchive[]>();
        archives.sort((a, b) => a.zoom - b.zoom || a.x - b.x || a.y - b.y);
        for (const archive of archives) {
            const key = shardKey(archive);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key)!.push(archive);
        }
        const shards: TerrainArchive[] = [];
        for (const [key, entries] of groups) {
            const bytes = Buffer.from(JSON.stringify({ schemaVersion: 2, encoding: 'int16-metres-gzip', grid: 'EPSG:4326',
                resolutionArcSeconds: TERRAIN_RESOLUTION_ARC_SECONDS, minZoom: 1, maxZoom: TERRAIN_MAX_ZOOM,
                archives: entries }));
            if (bytes.length > 512 * 1024) throw new Error('Terrain spatial index exceeds size bound');
            const sha256 = digest(bytes), file = `${sha256}.terrain`, [zoom, x, y] = key.split('/').map(Number);
            await writeFileAtomic(path.join(directory, file), bytes);
            shards.push({ zoom, x, y, file, sha256, byteLength: bytes.length });
        }
        // Large source inventories stay outside the small discovery manifest.
        const provenanceBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, product: 'USGS 3DEP 1 arc-second DEM',
            buildVersion: TERRAIN_BUILD_VERSION, gdal, resampling: 'max', quantization: 'ceil to whole metres',
            overviews: '2x2 maximum of child cells; missing children remain NoData',
            grid: 'EPSG:4326', resolutionArcSeconds: TERRAIN_RESOLUTION_ARC_SECONDS,
            sources: inputs.map(({ file, ...source }) => source) }));
        const provenanceSha = digest(provenanceBytes), provenanceFile = `${provenanceSha}.terrain-sources.json`;
        await writeFileAtomic(path.join(directory, provenanceFile), provenanceBytes);
        const content: Omit<TerrainManifest, 'generatedAt'> = { schemaVersion: 2 as const, encoding: 'int16-metres-gzip' as const, grid: 'EPSG:4326' as const,
            resolutionArcSeconds: TERRAIN_RESOLUTION_ARC_SECONDS, minZoom: 1 as const, maxZoom: TERRAIN_MAX_ZOOM,
            source: options.sourceDirectory ? 'Local USGS-format GeoTIFFs' : USGS_TERRAIN_SOURCE,
            attribution: '3DEP data courtesy of the U.S. Geological Survey',
            verticalDatum: 'Source-native orthometric datums; see per-source metadata in provenance',
            provenance: { file: provenanceFile, sha256: provenanceSha, byteLength: provenanceBytes.length }, shards };
        const manifestFile = path.join(directory, 'manifest.json');
        let previous: TerrainManifest | undefined;
        try { previous = JSON.parse(await fs.readFile(manifestFile, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        if (previous && typeof previous.generatedAt === 'string' && Number.isFinite(Date.parse(previous.generatedAt))) {
            const { generatedAt, ...oldContent } = previous;
            if (JSON.stringify(oldContent) === JSON.stringify(content)) {
                logger.log(`Terrain unchanged: ${batches.length - rebuilt} batches reused; ${rebuilt} repaired/rebuilt`);
                return previous;
            }
        }
        const manifest: TerrainManifest = { ...content, generatedAt: new Date().toISOString() };
        // Switch the pointer only after every input, archive, index and provenance file is complete.
        await writeFileAtomic(manifestFile, JSON.stringify(manifest));
        logger.log(`Terrain ready: ${batches.length - rebuilt} batches reused; ${rebuilt} rebuilt`);
        return manifest;
    } finally {
        try { if (work) await fs.rm(work, { recursive: true, force: true }); }
        finally { await release(); }
    }
}
