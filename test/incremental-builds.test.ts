import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import sharp from 'sharp';
import { downloadChartFiles } from '../download-charts.ts';
import { buildNasrData } from '../download-nasr.ts';
import { buildProcedureCatalog } from '../build-procedures.ts';
import { buildChartPackages } from '../build-chart-packages.ts';
import { buildChartCycles } from '../build-chart-cycles.ts';
import { packageChartCycle } from '../lib/chart-packager.ts';
import { pruneChartCycles } from '../lib/chart-retention.ts';
import { includesCycle, productCycleWindow } from '../lib/cycle-retention.ts';
import { sha256File } from '../lib/fs-utils.ts';
import type { ChartGroup } from '../lib/chart-discovery.ts';
import { rolloverFeed, TPP_ROOT } from './helpers/rollover-fixtures.ts';

const base = '2026-09-03', notice = '2026-10-01', next = '2026-10-29';
const json = async (file: string) => JSON.parse(await fs.readFile(file, 'utf8'));
async function fixture(t: TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-incremental-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const feed = await rolloverFeed(path.join(root, 'feed'));
    t.mock.method(globalThis, 'fetch', feed.fetch);
    const output = path.join(root, 'dist');
    return { root, output, feed, file: (...parts: string[]) => path.join(output, ...parts) };
}

test('unchanged ZIPs preserve extracted TIFFs and damaged extractions recover without a transfer', async t => {
    const f = await fixture(t);
    const url = 'https://aeronav.faa.gov/visual/09-03-2026/sectional-files/San_Francisco.zip';
    const groups: ChartGroup[] = [{ prefix: 'vfr-sectional', files: { San_Francisco: { current: {
        date: base, url, extractions: [{ sourceName: 'San_Francisco_SEC.tif', filename: 'vfr-sectional-san_francisco.tif' }]
    } } } }];
    await downloadChartFiles(groups, f.output, 1);
    const file = f.file('sources', base, 'charts/vfr-sectional-san_francisco.tif');
    const original = await fs.readFile(file), stat = await fs.stat(file);
    await downloadChartFiles(groups, f.output, 1);
    assert.equal((await fs.stat(file)).ino, stat.ino);
    assert.equal((await fs.stat(file)).mtimeMs, stat.mtimeMs);
    await fs.writeFile(file, Buffer.alloc(original.length));
    await downloadChartFiles(groups, f.output, 1);
    assert.deepEqual(await fs.readFile(file), original);
    assert.equal(f.feed.transferred.filter(request => request === url).length, 1);
});

test('unverified procedure mappings are rebuilt and damaged per-book indexes cannot supply page targets', async t => {
    const f = await fixture(t);
    const xml = path.join(f.root, 'metafile.xml');
    await fs.copyFile(new URL('./fixtures/procedure-catalog.xml', import.meta.url), xml);
    const books = f.file('sources', base, 'tpp');
    await fs.mkdir(books, { recursive: true });
    await fs.copyFile(new URL('./fixtures/procedure-volume.pdf', import.meta.url), path.join(books, 'tpp-sw2.pdf'));
    const options = { output: f.output, sourceXml: xml };
    const original = await buildProcedureCatalog(options);
    const directory = f.file('charts', base, 'tpp');
    const pointer = path.join(directory, 'manifest.json');
    const manifest = await json(pointer);
    const catalogFile = path.join(directory, manifest.file);
    const corrupt = await json(catalogFile);
    corrupt.airports[0].procedures[0].volumeTarget.pageIndex = 99999;
    await fs.writeFile(catalogFile, JSON.stringify(corrupt));
    const index = f.file('pdf-indexes', `${original.volumes[0].sha256}.tpp.json`);
    await fs.writeFile(index, '[{"pageIndex":99999}]');
    const repaired = await buildProcedureCatalog(options);
    assert.deepEqual(repaired.airports, original.airports);
    const committed = await json(pointer);
    assert.equal(await sha256File(path.join(directory, committed.file)), committed.sha256);
    assert.notEqual(await fs.readFile(index, 'utf8'), '[{"pageIndex":99999}]');
});

test('warm PDF builds avoid snapshots and notice revisions reuse the base book page index', async t => {
    const f = await fixture(t);
    const book = { date: base, url: `${TPP_ROOT}${base}/SW2.pdf` };
    await downloadChartFiles([{ prefix: 'tpp', files: { SW2: { current: book } } }], f.output, 1);
    const original = await buildProcedureCatalog({ output: f.output, today: base });
    const copy = t.mock.method(fs, 'copyFile', async () => { assert.fail('An unchanged published book must not be copied'); });
    try { assert.deepEqual(await buildProcedureCatalog({ output: f.output, today: base }), original); }
    finally { copy.mock.restore(); }
    const index = f.file('pdf-indexes', `${original.volumes[0].sha256}.tpp.json`);
    const before = await fs.stat(index);
    await downloadChartFiles([{ prefix: 'tpp', files: { SW2: { current: book }, CN: {
        current: { date: notice, url: `${TPP_ROOT}${notice}/CN.pdf` }
    } } }], f.output, 1);
    const updated = await buildProcedureCatalog({ output: f.output, today: notice });
    assert.equal(updated.volumes.find(volume => volume.id === 'SW2')!.sha256, original.volumes[0].sha256);
    assert.ok(updated.volumes.some(volume => volume.id === 'CN'));
    assert.equal((await fs.stat(index)).ino, before.ino);
    assert.equal((await fs.stat(index)).mtimeMs, before.mtimeMs);
});

test('warm navigation skips CSV and history parsing, preserves publication, and validates reused artifacts', async t => {
    const f = await fixture(t);
    const options = { output: f.output, today: notice, routeHistorySource: f.feed.history };
    await buildNasrData(options);
    const manifestFile = f.file('charts', notice, 'nav/manifest.json');
    const original = await fs.readFile(manifestFile), before = await fs.stat(manifestFile);
    const readFile = fs.readFile.bind(fs);
    const reads = t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
        assert.ok(!String(args[0]).endsWith('.csv'), 'Unchanged navigation must not parse NASR CSVs');
        return readFile(...args);
    });
    const queries = t.mock.method(DatabaseSync.prototype, 'prepare', () => { assert.fail('Unchanged history must not query SQLite'); });
    try { await buildNasrData(options); }
    finally { reads.mock.restore(); queries.mock.restore(); }
    assert.deepEqual(await fs.readFile(manifestFile), original);
    assert.equal((await fs.stat(manifestFile)).ino, before.ino);
    const index = await buildChartCycles(f.output), indexStat = await fs.stat(f.file('charts/cycles.json'));
    assert.deepEqual(await buildChartCycles(f.output), index);
    assert.equal((await fs.stat(f.file('charts/cycles.json'))).ino, indexStat.ino);
    // A changing daily history source does not invalidate the FAA projection.
    const database = new DatabaseSync(f.feed.history);
    database.exec('UPDATE sfdps_routes_by_type SET use_count=use_count+1 WHERE use_count > 0');
    database.close();
    const noCsv = t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
        assert.ok(!String(args[0]).endsWith('.csv'));
        return readFile(...args);
    });
    try { await buildNasrData(options); }
    finally { noCsv.mock.restore(); }
    const updated = await json(manifestFile), previous = JSON.parse(original.toString());
    assert.deepEqual(updated.products.filter(product => product.id !== 'route-history'),
        previous.products.filter(product => product.id !== 'route-history'));
    assert.notEqual(updated.products.find(product => product.id === 'route-history').sha256,
        previous.products.find(product => product.id === 'route-history').sha256);
    const airportFile = f.file('charts', notice, 'nav', updated.products.find(product => product.id === 'airports').file);
    await fs.writeFile(airportFile, 'corrupt publication');
    await assert.rejects(buildNasrData(options), /Published artifact is corrupt/);
});

test('expired broken raster packages are excluded from build work and deleted only by successful retention', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-incremental-packages-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const old = '2026-07-09';
    const png = await sharp({ create: { width: 256, height: 256, channels: 4, background: '#ff0000' } }).png().toBuffer();
    let oldArchive: string;
    for (const date of [old, base, next]) {
        const cache = path.join(root, 'mbtiles', date), delivery = path.join(root, 'charts', date, 'mbtiles');
        await fs.mkdir(cache, { recursive: true });
        const file = path.join(cache, 'test.mbtiles');
        const database = new DatabaseSync(file);
        database.exec('CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB,PRIMARY KEY(zoom_level,tile_column,tile_row))');
        database.prepare('INSERT INTO tiles VALUES (0,0,0,?)').run(png);
        database.close();
        await fs.writeFile(path.join(cache, 'chart-manifest.json'), JSON.stringify({ schemaVersion: 1, effectiveDate: date,
            generatedAt: '2026-10-29T10:00:00Z', charts: [{ id: 'test', file: 'test.mbtiles', title: 'test', kind: 'vfr-sectional',
                bounds: [-180, -85, 180, 85], minZoom: 0, maxZoom: 0, byteLength: (await fs.stat(file)).size,
                sha256: await sha256File(file), sourceByteLength: 1, sourceSha256: 'a'.repeat(64), tilerVersion: 1,
                buildConfigurationSha256: 'b'.repeat(64), cutlineProvenance: 'fixture' }] }));
        const packaged = await packageChartCycle(cache, delivery);
        if (date === old) oldArchive = path.join(delivery, packaged.archives[0].file);
    }
    await fs.writeFile(oldArchive, 'damaged expired archive');
    // Model planning before a new edition has committed its delivery manifest.
    const nextPointer = path.join(root, 'charts', next, 'mbtiles/manifest.json');
    const pointer = await fs.readFile(nextPointer);
    await fs.rm(nextPointer);
    const planned = await productCycleWindow(root, 'mbtiles', 2, next, [next]);
    assert.equal(includesCycle(planned, old), false);
    assert.equal((await productCycleWindow(root, 'mbtiles', 2, next)).oldest, old,
        'an uncommitted edition cannot yet authorize deletion');
    await fs.writeFile(nextPointer, pointer);
    await buildChartPackages(root, undefined, false, planned);
    assert.equal(await fs.readFile(oldArchive, 'utf8'), 'damaged expired archive');
    await pruneChartCycles(root, 2, next);
    await assert.rejects(fs.access(oldArchive), { code: 'ENOENT' });
});
