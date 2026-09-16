import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import sharp from 'sharp';

import { packageChartCycle, validateRegions, type ChartPackageManifest } from '../lib/chart-packager.ts';
import { tileBounds, type Bounds, type Tile } from '../lib/chart-package-grid.ts';
import { sha256File, type ChartManifest } from '../lib/chart-tiler.ts';
import { CHARTMAKER_COMMIT } from '../lib/chartmaker-cutlines.ts';
import { PackageSource } from '../lib/chart-package-source.ts';

async function fixture(t: TestContext) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-packages-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const manifest: ChartManifest = { schemaVersion: 1, effectiveDate: '2026-09-03', generatedAt: '2026-09-15T00:00:00Z', charts: [] };
    return {
        directory, output: path.join(directory, 'delivery'), manifest,
        async add(id: string, bounds: Bounds, tiles: Array<Tile & { data: Buffer }>) {
            const file = `${id}.mbtiles`;
            const db = new DatabaseSync(path.join(directory, file));
            try {
                db.exec('CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB,PRIMARY KEY(zoom_level,tile_column,tile_row))');
                const insert = db.prepare('INSERT INTO tiles VALUES (?,?,?,?)');
                for (const tile of tiles) insert.run(tile.z, tile.x, 2 ** tile.z - 1 - tile.y, tile.data);
            } finally { db.close(); }
            manifest.charts.push({
                id, file, title: id, kind: 'vfr-sectional', bounds,
                minZoom: Math.min(...tiles.map(tile => tile.z)), maxZoom: Math.max(...tiles.map(tile => tile.z)),
                byteLength: (await fs.stat(path.join(directory, file))).size,
                sha256: await sha256File(path.join(directory, file)),
                sourceByteLength: 1, sourceSha256: 'a'.repeat(64), tilerVersion: 1,
                buildConfigurationSha256: 'b'.repeat(64), cutlineProvenance: `N129BZ/chartmaker@${CHARTMAKER_COMMIT}`
            });
        },
        async save() { await fs.writeFile(path.join(directory, 'chart-manifest.json'), JSON.stringify(manifest)); }
    };
}

const color = (background: string) => sharp({ create: { width: 256, height: 256, channels: 4, background } }).png().toBuffer();

async function pausePackager(t: TestContext, directory: string, output: string) {
    const packager = new URL('../lib/chart-packager.ts', import.meta.url).href;
    const source = new URL('../lib/chart-package-source.ts', import.meta.url).href;
    const child = spawn(process.execPath, ['--import=tsx', '--input-type=module', '-e', `
        import { packageChartCycle } from ${JSON.stringify(packager)};
        import { PackageSource } from ${JSON.stringify(source)};
        const prepare = PackageSource.prototype.prepare;
        PackageSource.prototype.prepare = async function () {
            await prepare.call(this);
            await new Promise(resolve => {
                process.once('message', resolve);
                process.send('pinned');
            });
        };
        await packageChartCycle(${JSON.stringify(directory)}, ${JSON.stringify(output)}, { force: true });
        process.disconnect();
    `], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = once(child, 'exit');
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
    });
    const [message] = await Promise.race([
        once(child, 'message'),
        exited.then(() => { throw new Error('Packager exited before pinning its source'); })
    ]);
    assert.equal(message, 'pinned');
    const work = (await fs.readdir(directory)).filter(file => file.startsWith('.packages-work-'));
    assert.equal(work.length, 1);
    return { child, exited, scratch: path.join(directory, work[0]) };
}

async function packagedTile(directory: string, manifest: ChartPackageManifest, tile: Tile) {
    for (const archive of manifest.archives.filter(archive => archive.zoom === tile.z)) {
        const db = new DatabaseSync(path.join(directory, 'delivery', archive.file), { readOnly: true });
        try {
            const row = db.prepare('SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?')
                .get(tile.z, tile.x, 2 ** tile.z - 1 - tile.y);
            if (row) return Buffer.from(row.tile_data as Uint8Array);
        } finally { db.close(); }
    }
    throw new Error(`Missing packaged tile: ${JSON.stringify(tile)}`);
}

test('stitches sheets in stable order, fills lower zooms, and preserves transparent holes', async t => {
    const f = await fixture(t);
    const area: Bounds = [-179, 1, -1, 84];
    const red = await color('#ff0000');
    const blue = await sharp({ create: { width: 128, height: 256, channels: 4, background: '#0000ff' } })
        .extend({ right: 128, background: '#00000000' }).png().toBuffer();
    // Reverse input order deliberately. The alphabetically later sheet is on top.
    await f.add('b', area, [{ z: 2, x: 0, y: 0, data: blue }]);
    await f.add('a', area, [{ z: 1, x: 0, y: 0, data: red }]);
    await f.save();
    const manifest = await packageChartCycle(f.directory, f.output);
    assert.deepEqual([...new Set(manifest.archives.map(archive => archive.zoom))], [0, 1, 2]);
    const pixels = await sharp(await packagedTile(f.directory, manifest, { z: 2, x: 0, y: 0 })).ensureAlpha().raw().toBuffer();
    assert.ok(pixels[(128 * 256 + 64) * 4 + 2] > 240, 'blue sheet on top');
    assert.ok(pixels[(128 * 256 + 192) * 4] > 240, 'coarser red sheet visible through transparent half');
    assert.deepEqual(manifest.regions[0].archiveIds, manifest.archives.map(archive => archive.id));
    const again = await packageChartCycle(f.directory, f.output);
    assert.deepEqual(again.archives, manifest.archives, 'unchanged inputs reuse content identities');

    const holes = await fixture(t);
    await holes.add('hole', area, [{ z: 2, x: 0, y: 0, data: blue }]);
    await holes.save();
    const clipped = await packageChartCycle(holes.directory, holes.output);
    const empty = await sharp(await packagedTile(holes.directory, clipped, { z: 2, x: 1, y: 1 })).stats();
    assert.equal(empty.channels[3].max, 0, 'missing native tile is explicitly transparent');
    const overview = await sharp(await packagedTile(holes.directory, clipped, { z: 0, x: 0, y: 0 })).stats();
    assert.equal(overview.channels[3].max, 255, 'chart remains present at world zoom');
});

test('splits oversized spatial blocks, checks identities, and leaves the published index intact on failure', async t => {
    const f = await fixture(t);
    const noise = await sharp(randomBytes(256 * 256 * 3), { raw: { width: 256, height: 256, channels: 3 } }).webp({ quality: 92 }).toBuffer();
    const area = tileBounds({ z: 2, x: 0, y: 0 });
    // Avoid numerical ambiguity exactly on Mercator grid edges.
    area[0] += 0.001; area[1] += 0.001; area[2] -= 0.001; area[3] -= 0.001;
    await f.add('noise', area, [0, 1].flatMap(x => [0, 1].map(y => ({ z: 3, x, y, data: noise }))));
    await f.save();
    const maximumArchiveBytes = 128 * 1024;
    const manifest = await packageChartCycle(f.directory, f.output, { maximumArchiveBytes, regions: [
        { id: 'west', title: 'West', bounds: [area] }, { id: 'also-west', title: 'Also west', bounds: [area] },
        { id: 'east', title: 'East', bounds: [[1, -10, 10, 10]] }
    ] });
    assert.ok(manifest.archives.filter(archive => archive.zoom === 3).length > 1);
    assert.deepEqual(manifest.regions[0].archiveIds, manifest.regions[1].archiveIds);
    assert.deepEqual(manifest.regions[0].archiveIds, manifest.archives.map(archive => archive.id));
    // Only the world-spanning overview packages intersect the eastern region.
    assert.deepEqual(manifest.regions[2].archiveIds, [
        'vfr-sectional-z0-r0-0-0', 'vfr-sectional-z1-r0-0-0', 'vfr-sectional-z2-r0-0-0'
    ]);
    for (const archive of manifest.archives) {
        const file = path.join(f.output, archive.file);
        assert.ok(archive.byteLength <= maximumArchiveBytes);
        assert.equal((await fs.stat(file)).size, archive.byteLength);
        assert.equal(await sha256File(file), archive.sha256);
        const db = new DatabaseSync(file, { readOnly: true });
        try { assert.equal(db.prepare('PRAGMA quick_check').get()?.quick_check, 'ok'); }
        finally { db.close(); }
    }
    const published = await fs.readFile(path.join(f.output, 'manifest.json'), 'utf8');
    f.manifest.charts[0].sha256 = '0'.repeat(64);
    await f.save();
    await assert.rejects(packageChartCycle(f.directory, f.output), /Stale chart/);
    assert.equal(await fs.readFile(path.join(f.output, 'manifest.json'), 'utf8'), published);
    assert.equal((await fs.readdir(f.directory)).some(file => file.includes('work-') || file.endsWith('.build.lock')), false);
});

test('validates region definitions before expensive packaging work', () => {
    validateRegions([{ id: 'dateline', title: 'Aleutians', bounds: [[170, 50, 180, 55], [-180, 50, -170, 55]] }]);
    for (const invalid of [null, {}, [null], [{ id: 'bad', title: 'Bad', bounds: [[170, 50, -170, 55]] }]]) {
        assert.throws(() => validateRegions(invalid as never), /region/i);
    }
});

test('verified packages skip composition even after a sheet-manifest timestamp refresh', async t => {
    const f = await fixture(t);
    await f.add('sheet', [-180, -85, 180, 85], [{ z: 0, x: 0, y: 0, data: await color('#ff0000') }]);
    await f.save();
    const prepare = t.mock.method(PackageSource.prototype, 'prepare');
    const original = await packageChartCycle(f.directory, f.output);
    assert.equal(prepare.mock.callCount(), 1);
    const file = path.join(f.output, 'manifest.json');
    await fs.utimes(file, 1, 1);
    f.manifest.generatedAt = '2026-09-16T00:00:00Z';
    await f.save();
    assert.deepEqual(await packageChartCycle(f.directory, f.output), original);
    assert.equal(prepare.mock.callCount(), 1, 'no overviews or composition on a verified cache hit');
    assert.equal((await fs.stat(file)).mtimeMs, 1000, 'published manifest is not rewritten');
    assert.equal((await fs.stat(path.join(f.directory, 'sheet.mbtiles'))).nlink, 1);

    await packageChartCycle(f.directory, f.output, { force: true });
    assert.equal(prepare.mock.callCount(), 2);
    const db = new DatabaseSync(path.join(f.directory, 'sheet.mbtiles'));
    try { db.exec('UPDATE tiles SET tile_column=1'); } finally { db.close(); }
    await assert.rejects(packageChartCycle(f.directory, f.output), /Stale chart/);
});

test('package reuse invalidates changed regions, budgets, provenance, and sheet contents', async t => {
    const f = await fixture(t);
    const bounds: Bounds = [-180, -85, 180, 85];
    await f.add('sheet', bounds, [{ z: 0, x: 0, y: 0, data: await color('#ff0000') }]);
    await f.save();
    const prepare = t.mock.method(PackageSource.prototype, 'prepare');
    await packageChartCycle(f.directory, f.output);
    const regions = [{ id: 'trip', title: 'Trip', bounds: [bounds] }];
    const custom = await packageChartCycle(f.directory, f.output, { regions });
    assert.equal(custom.regions[0].id, 'trip');
    const maximumArchiveBytes = 64 * 1024;
    const smaller = await packageChartCycle(f.directory, f.output, { regions, maximumArchiveBytes });
    assert.equal(smaller.maximumArchiveBytes, maximumArchiveBytes);
    f.manifest.charts[0].buildConfigurationSha256 = 'c'.repeat(64);
    await f.save();
    await packageChartCycle(f.directory, f.output, { regions, maximumArchiveBytes });

    const db = new DatabaseSync(path.join(f.directory, 'sheet.mbtiles'));
    try { db.prepare('UPDATE tiles SET tile_data=?').run(await color('#0000ff')); }
    finally { db.close(); }
    f.manifest.charts[0].sha256 = await sha256File(path.join(f.directory, 'sheet.mbtiles'));
    f.manifest.charts[0].byteLength = (await fs.stat(path.join(f.directory, 'sheet.mbtiles'))).size;
    await f.save();
    const changed = await packageChartCycle(f.directory, f.output, { regions, maximumArchiveBytes });
    assert.equal(prepare.mock.callCount(), 5);
    const pixels = await sharp(await packagedTile(f.directory, changed, { z: 0, x: 0, y: 0 })).raw().toBuffer();
    assert.ok(pixels[2] > 240, 'updated imagery reaches the packages');
});

test('missing package outputs rebuild; corrupt archives fail before reuse', async t => {
    const f = await fixture(t);
    await f.add('sheet', [-180, -85, 180, 85], [{ z: 0, x: 0, y: 0, data: await color('#ff0000') }]);
    await f.save();
    const prepare = t.mock.method(PackageSource.prototype, 'prepare');
    const original = await packageChartCycle(f.directory, f.output);
    const archive = path.join(f.output, original.archives[0].file);
    await fs.rm(archive);
    assert.deepEqual((await packageChartCycle(f.directory, f.output)).archives, original.archives);
    const manifestFile = path.join(f.output, 'manifest.json');
    await fs.writeFile(manifestFile, JSON.stringify({ ...original, archives: [] }));
    assert.deepEqual((await packageChartCycle(f.directory, f.output)).archives, original.archives);
    const receipt = (await fs.readdir(f.directory)).find(file => file.startsWith('chart-packages-'))!;
    await fs.writeFile(path.join(f.directory, receipt), '{broken');
    await packageChartCycle(f.directory, f.output);
    assert.equal(prepare.mock.callCount(), 4);

    const bytes = await fs.readFile(archive);
    bytes[bytes.length - 1] ^= 1;
    await fs.writeFile(archive, bytes);
    await assert.rejects(packageChartCycle(f.directory, f.output), /Corrupt existing package/);
    assert.equal(prepare.mock.callCount(), 4, 'corrupt existing packages are rejected before expensive work');
});

test('a sheet replaced after pinning retains its verified imagery and provenance', async t => {
    const f = await fixture(t);
    const replacement = await fixture(t);
    const tile = { z: 0, x: 0, y: 0 };
    const bounds: Bounds = [-180, -85, 180, 85];
    await f.add('sheet', bounds, [{ ...tile, data: await color('#ff0000') }]);
    await replacement.add('sheet', bounds, [{ ...tile, data: await color('#0000ff') }]);
    await f.save();
    const source = path.join(f.directory, 'sheet.mbtiles');
    const link = fs.link;
    t.mock.method(fs, 'link', async (...args: Parameters<typeof link>) => {
        await link(...args);
        if (args[0] === source) {
            await fs.rename(path.join(replacement.directory, 'sheet.mbtiles'), source);
        }
    });
    const manifest = await packageChartCycle(f.directory, f.output);
    assert.equal(manifest.charts[0].sha256, f.manifest.charts[0].sha256);
    assert.equal(await sha256File(source), replacement.manifest.charts[0].sha256);
    const pixels = await sharp(await packagedTile(f.directory, manifest, tile)).ensureAlpha().raw().toBuffer();
    assert.ok(pixels[0] > 240 && pixels[2] < 15, 'packaged pixels come from the verified red sheet');
    assert.equal((await fs.readdir(f.directory)).some(file => file.startsWith('.packages-work-')), false);
});

test('retries reclaim a killed packager\'s work and release its old source pins', { timeout: 10_000 }, async t => {
    const f = await fixture(t);
    const replacement = await fixture(t);
    const tile = { z: 0, x: 0, y: 0 };
    const bounds: Bounds = [-180, -85, 180, 85];
    await f.add('sheet', bounds, [{ ...tile, data: await color('#ff0000') }]);
    await replacement.add('sheet', bounds, [{ ...tile, data: await color('#0000ff') }]);
    await f.save();
    const original = await packageChartCycle(f.directory, f.output);
    const published = await fs.readFile(path.join(f.output, 'manifest.json'), 'utf8');
    const held = await pausePackager(t, f.directory, f.output);
    const source = path.join(f.directory, 'sheet.mbtiles');
    await fs.access(path.join(held.scratch, 'work.sqlite'));
    assert.equal((await fs.stat(source)).nlink, 2);
    held.child.kill('SIGKILL');
    await held.exited;
    assert.equal(await fs.readFile(path.join(f.output, 'manifest.json'), 'utf8'), published);

    // Keep one witness link to the old inode, then simulate a sheet rebuild.
    // Reaping the dead snapshot must release that inode even after replacement.
    const witness = path.join(f.directory, 'old-sheet.mbtiles');
    await fs.link(source, witness);
    await fs.rename(path.join(replacement.directory, 'sheet.mbtiles'), source);
    f.manifest.charts = replacement.manifest.charts;
    await f.save();
    assert.equal((await fs.stat(witness)).nlink, 2);

    const [retried, concurrent] = await Promise.all([
        packageChartCycle(f.directory, f.output),
        packageChartCycle(f.directory, path.join(f.directory, 'other-delivery'))
    ]);
    assert.deepEqual(retried.archives, concurrent.archives);
    await assert.rejects(fs.access(held.scratch), /ENOENT/);
    assert.equal((await fs.stat(witness)).nlink, 1);
    assert.equal((await fs.stat(source)).nlink, 1);
    assert.equal((await fs.readdir(f.directory)).some(file => file.startsWith('.packages-work-')), false);
    assert.equal(retried.charts[0].sha256, replacement.manifest.charts[0].sha256);
    for (const archive of original.archives) await fs.access(path.join(f.output, archive.file));
});

test('cleanup preserves live packagers sharing inputs and legacy work without an owner', { timeout: 10_000 }, async t => {
    const f = await fixture(t);
    await f.add('sheet', [-180, -85, 180, 85], [{ z: 0, x: 0, y: 0, data: await color('#ff0000') }]);
    await f.save();
    const held = await pausePackager(t, f.directory, f.output);
    const legacy = await fs.mkdtemp(path.join(f.directory, '.packages-work-'));
    await fs.writeFile(path.join(legacy, 'work.sqlite'), 'unknown owner');
    await assert.rejects(packageChartCycle(f.directory, f.output), /already in progress/);

    const other = await packageChartCycle(f.directory, path.join(f.directory, 'other-delivery'));
    await fs.access(path.join(held.scratch, 'sources', 'sheet.mbtiles'));
    assert.equal((await fs.stat(path.join(f.directory, 'sheet.mbtiles'))).nlink, 2);
    assert.equal(await fs.readFile(path.join(legacy, 'work.sqlite'), 'utf8'), 'unknown owner');
    held.child.send('resume');
    assert.deepEqual(await held.exited, [0, null]);
    await assert.rejects(fs.access(held.scratch), /ENOENT/);
    const completed = JSON.parse(await fs.readFile(path.join(f.output, 'manifest.json'), 'utf8'));
    assert.deepEqual(completed.archives, other.archives);
    assert.equal((await fs.stat(path.join(f.directory, 'sheet.mbtiles'))).nlink, 1);
});
