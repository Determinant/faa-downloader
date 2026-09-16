import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { ChartManifest } from './chart-tiler.ts';
import { acquireChartBuildLock, processIsRunning } from './chart-build-lock.ts';
import { compositeTile } from './chart-package-images.ts';
import { PackageSource } from './chart-package-source.ts';
import {
    packageId, packageRoot, regionArchives, tileBounds, tileRange,
    type ChartPackageArchive, type ChartOfflineRegion, type Tile
} from './chart-package-grid.ts';
import { mapWithConcurrency } from './concurrency.ts';
import { sha256File, writeFileAtomic } from './fs-utils.ts';
import type { ChartKind } from './chart-definitions.ts';

export type OfflineRegionDefinition = Omit<ChartOfflineRegion, 'archiveIds'>;
export type ChartPackageManifest = Omit<ChartManifest, 'schemaVersion'> & {
    schemaVersion: 2;
    packagingVersion: 1;
    maximumArchiveBytes: number;
    archives: ChartPackageArchive[];
    regions: ChartOfflineRegion[];
};
type EncodedTile = Tile & { data: Buffer };
export const MAXIMUM_ARCHIVE_BYTES = 4 * 1024 * 1024;

async function removeAbandonedPackageWork(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        // Legacy directories have no owner, so their safety cannot be inferred.
        const match = entry.isDirectory() && entry.name.match(/^\.packages-work-([1-9]\d*)-[a-zA-Z0-9]{6}$/);
        if (!match) continue;
        const pid = Number(match[1]);
        if (Number.isSafeInteger(pid) && !processIsRunning(pid)) {
            // Names are unique to an invocation and never reused. Concurrent
            // packagers targeting other outputs may reap the same dead owner.
            await fs.rm(path.join(directory, entry.name), { recursive: true, force: true });
        }
    }
}

// Sheet archives remain reusable build inputs outside charts/. Only output is
// published; the original chart list supplies coverage and provenance.
export async function packageChartCycle(
    directory: string,
    output: string,
    options: { maximumArchiveBytes?: number; regions?: OfflineRegionDefinition[] } = {}
): Promise<ChartPackageManifest> {
    const maximumBytes = options.maximumArchiveBytes ?? MAXIMUM_ARCHIVE_BYTES;
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 32_768) {
        throw new Error('maximumArchiveBytes must be an integer of at least 32768');
    }
    assert.notEqual(path.resolve(directory), path.resolve(output), 'Input and delivery directories must differ');
    await fs.mkdir(output, { recursive: true });
    const release = await acquireChartBuildLock(path.join(output, 'packages'));
    let scratch: string | undefined;
    let work: DatabaseSync | undefined;
    const sources: PackageSource[] = [];
    try {
        await removeAbandonedPackageWork(directory);
        const manifest: ChartManifest = JSON.parse(await fs.readFile(path.join(directory, 'chart-manifest.json'), 'utf8'));
        assert.equal(manifest.schemaVersion, 1, 'Expected a verified sheet manifest');
        assert.ok(manifest.charts.length > 0, 'No chart sheets to package');
        assert.equal(new Set(manifest.charts.map(chart => chart.id)).size, manifest.charts.length);
        const footprints = manifest.charts.map(chart => ({
            id: chart.id, title: chart.title, bounds: [chart.bounds]
        }));
        validateRegions(footprints);
        const regions = options.regions ?? footprints;
        if (options.regions !== undefined) validateRegions(options.regions);
        // Publish ownership in the mkdir itself, before any SQLite files or
        // source hard links exist, so interruption cannot leave an ownerless pin.
        scratch = await fs.mkdtemp(path.join(directory, `.packages-work-${process.pid}-`));
        const snapshots = path.join(scratch, 'sources');
        await fs.mkdir(snapshots);
        work = new DatabaseSync(path.join(scratch, 'work.sqlite'));
        work.exec(`PRAGMA journal_mode=OFF; PRAGMA cache_size=-16384;
            CREATE TABLE overviews(source TEXT,z INTEGER,x INTEGER,y INTEGER,data BLOB,PRIMARY KEY(source,z,x,y)) WITHOUT ROWID;
            CREATE TABLE coverage(kind TEXT,z INTEGER,bx INTEGER,by INTEGER,x INTEGER,y INTEGER,
                PRIMARY KEY(kind,z,bx,by,x,y)) WITHOUT ROWID;`);
        const add = work.prepare('INSERT OR IGNORE INTO coverage VALUES (?,?,?,?,?,?)');
        for (const chart of [...manifest.charts].sort((a, b) => a.id.localeCompare(b.id))) {
            assert.ok(['vfr-sectional', 'vfr-terminal', 'vfr-flyway', 'ifr-low'].includes(chart.kind),
                `Unknown chart kind: ${chart.kind}`);
            assert.ok(Number.isInteger(chart.minZoom) && chart.minZoom >= 0 &&
                Number.isInteger(chart.maxZoom) && chart.maxZoom >= chart.minZoom && chart.maxZoom <= 24,
            `Invalid zoom range: ${chart.id}`);
            assert.equal(chart.file, `${chart.id}.mbtiles`);
            assert.equal(path.basename(chart.file), chart.file, 'Unsafe chart filename');
            // Tilers replace sheets by rename. Pin the inode before verification
            // so hashing and SQLite always read the same version during a rebuild.
            const file = path.join(snapshots, chart.file);
            await fs.link(path.join(directory, chart.file), file);
            assert.equal((await fs.stat(file)).size, chart.byteLength, `Stale chart: ${chart.id}`);
            assert.equal(await sha256File(file), chart.sha256, `Stale chart: ${chart.id}`);
            const source = new PackageSource(chart, file, work);
            sources.push(source);
            await source.prepare();
            work.exec('BEGIN');
            // Include transparent boundary cells too. Their explicit index entries
            // prevent a clipped-away native tile being filled by a coarser parent.
            for (let z = 0; z <= chart.maxZoom; z += 1) {
                const [x0, y0, x1, y1] = tileRange(chart.bounds, z);
                for (let x = x0; x <= x1; x += 1) for (let y = y0; y <= y1; y += 1) {
                    add.run(chart.kind, z, Math.floor(x / 8), Math.floor(y / 8), x, y);
                }
            }
            work.exec('COMMIT');
        }

        const archives: ChartPackageArchive[] = [];
        const groups = work.prepare('SELECT kind,z,bx,by FROM coverage GROUP BY kind,z,bx,by ORDER BY kind,z,bx,by');
        const coordinates = work.prepare('SELECT x,y FROM coverage WHERE kind=? AND z=? AND bx=? AND by=?');
        let count = 0;
        for (const group of groups.iterate()) {
            const kind = group.kind as ChartKind;
            const z = Number(group.z);
            const relevant = sources.filter(source => source.chart.kind === kind);
            const tiles = await mapWithConcurrency(coordinates.all(kind, z, group.bx, group.by), 4, async row => {
                const tile = { z, x: Number(row.x), y: Number(row.y) };
                const parts = await Promise.all(relevant.map(source => source.tile(tile)));
                return { ...tile, data: await compositeTile(parts.filter(part => part !== undefined)) };
            });
            await writeShard(tiles, kind, packageRoot(tiles[0]), scratch, output, maximumBytes, archives);
            if (++count % 100 === 0) console.log(`Packaged ${count} spatial/zoom blocks (${archives.length} files)`);
        }
        const result: ChartPackageManifest = {
            ...manifest, schemaVersion: 2, packagingVersion: 1,
            generatedAt: new Date().toISOString(), maximumArchiveBytes: maximumBytes,
            archives,
            regions: regions.map(region => ({ ...region, archiveIds: regionArchives(region.bounds, archives) }))
        };
        // Immutable, content-addressed files are present before the pointer changes.
        // Previous files remain valid for open clients and previously saved regions.
        await writeFileAtomic(path.join(output, 'manifest.json'), `${JSON.stringify(result)}\n`);
        return result;
    } finally {
        for (const source of sources) source.close();
        work?.close();
        if (scratch) await fs.rm(scratch, { recursive: true, force: true });
        await release();
    }
}

async function writeShard(
    tiles: EncodedTile[], kind: ChartKind, root: Tile, scratch: string, output: string,
    maximumBytes: number, archives: ChartPackageArchive[]
): Promise<void> {
    if (tiles.length === 0) return;
    const zoom = tiles[0].z;
    const id = packageId(kind, zoom, root);
    const temporary = path.join(scratch, `${id}.mbtiles`);
    const db = new DatabaseSync(temporary);
    const bounds = tileBounds(root);
    try {
        db.exec(`PRAGMA journal_mode=OFF;
            CREATE TABLE metadata(name TEXT PRIMARY KEY,value TEXT);
            CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB,
                PRIMARY KEY(zoom_level,tile_column,tile_row)); BEGIN;`);
        const metadata = db.prepare('INSERT INTO metadata VALUES (?,?)');
        for (const [name, value] of Object.entries({
            name: id, type: 'overlay', version: '1.3', format: 'webp',
            bounds: bounds.join(','), minzoom: String(zoom), maxzoom: String(zoom)
        })) metadata.run(name, value);
        const add = db.prepare('INSERT INTO tiles VALUES (?,?,?,?)');
        for (const tile of tiles) add.run(zoom, tile.x, 2 ** zoom - 1 - tile.y, tile.data);
        db.exec('COMMIT');
    } finally { db.close(); }
    const byteLength = (await fs.stat(temporary)).size;
    if (byteLength > maximumBytes) {
        await fs.rm(temporary);
        if (root.z === zoom) throw new Error(`A single tile exceeds the archive budget: ${id}`);
        const span = 2 ** (zoom - root.z - 1);
        for (let dy = 0; dy < 2; dy += 1) for (let dx = 0; dx < 2; dx += 1) {
            const child = { z: root.z + 1, x: root.x * 2 + dx, y: root.y * 2 + dy };
            await writeShard(tiles.filter(tile => Math.floor(tile.x / span) === child.x &&
                Math.floor(tile.y / span) === child.y), kind, child, scratch, output, maximumBytes, archives);
        }
        return;
    }
    const sha256 = await sha256File(temporary);
    const file = `${id}-${sha256}.mbtiles`;
    try { await fs.link(temporary, path.join(output, file)); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        assert.equal(await sha256File(path.join(output, file)), sha256, 'Corrupt existing package');
    }
    await fs.rm(temporary);
    const span = 2 ** (zoom - root.z);
    let mask = 0n;
    for (const tile of tiles) mask |= 1n << BigInt((tile.y - root.y * span) * span + tile.x - root.x * span);
    archives.push({ id, kind, file, zoom, root, bounds, tileMask: mask.toString(16), byteLength, sha256 });
}

export function validateRegions(regions: readonly OfflineRegionDefinition[]): void {
    if (!Array.isArray(regions)) throw new Error('Offline regions must be an array');
    const ids = new Set<string>();
    for (const region of regions) {
        if (!region || typeof region.id !== 'string' || !region.id.trim() ||
            typeof region.title !== 'string' || !region.title.trim() || ids.has(region.id) || !Array.isArray(region.bounds) ||
            !region.bounds.length || region.bounds.some(bounds => !Array.isArray(bounds) || bounds.length !== 4 ||
                !bounds.every(Number.isFinite) || bounds[0] < -180 || bounds[2] > 180 ||
                bounds[1] < -90 || bounds[3] > 90 || bounds[0] >= bounds[2] || bounds[1] >= bounds[3])) {
            throw new Error(`Invalid offline region: ${region?.id}`);
        }
        ids.add(region.id);
    }
}
