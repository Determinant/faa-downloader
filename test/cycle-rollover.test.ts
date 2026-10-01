import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import sharp from 'sharp';
import { downloadChartFiles } from '../download-charts.ts';
import { migratePdfBooks } from '../clean-generated.ts';
import { buildNasrData } from '../download-nasr.ts';
import { prepareProcedureCatalog } from '../build-procedures.ts';
import { buildChartSupplements } from '../build-chart-supplements.ts';
import { buildChartPackages } from '../build-chart-packages.ts';
import { buildChartCycles } from '../build-chart-cycles.ts';
import { discoverCharts, type ChartGroup } from '../lib/chart-discovery.ts';
import { chartMbtilesPath, chartSourceDirectory } from '../lib/chart-paths.ts';
import { sha256File, writeChartBuildReceipt, writeChartManifests } from '../lib/chart-tiler.ts';
import { editions, rolloverFeed, TPP_ROOT } from './helpers/rollover-fixtures.ts';

const json = async (file: string) => JSON.parse(await fs.readFile(file, 'utf8'));
const representative: Record<string, string[]> = { cs: ['SW'], tpp: ['SW2', 'CN'], 'vfr-sectional': ['San_Francisco'] };

test('an interrupted same-edition correction preserves published books and recovers without retiling', async t => {
    const f = await fixture(t);
    const first = editions[0];
    const before = await f.run(first.date);
    const book = before.procedures.volumes.find(volume => volume.id === 'SW2');
    // Upgrade from the old fixed-name layout without overwriting a saved URL.
    const source = path.join(f.output, 'sources', first.date, 'tpp', 'tpp-sw2.pdf');
    await fs.link(source, f.file(first.date, 'tpp/tpp-sw2.pdf'));
    await fs.rm(source);
    const url = `${TPP_ROOT}${first.date}/SW2.pdf`;
    const bytes = f.feed.responses.get(url);
    assert.ok(bytes);
    // Same-size content edit preserves this tiny fixture's PDF stream/xref offsets.
    f.feed.responses.set(url, Buffer.from(Buffer.from(bytes).toString('latin1').replace('Approach', 'Correct!'), 'latin1'));
    const rename = fs.rename.bind(fs);
    const interrupted = t.mock.method(fs, 'rename', async (from, to) => {
        if (String(to) === f.file(first.date, 'nav/manifest.json')) throw new Error('Interrupted after PDF acquisition');
        return rename(from, to);
    });
    try { await assert.rejects(f.run(first.date), /Interrupted after PDF acquisition/); }
    finally { interrupted.mock.restore(); }
    await verifyPublished(f.charts);
    await identity(f.file(first.date, 'tpp'), book);
    await identity(f.file(first.date, 'tpp'), { ...book, url: 'tpp-sw2.pdf' });
    const after = await f.run(first.date);
    const corrected = after.procedures.volumes.find(volume => volume.id === 'SW2');
    assert.notEqual(corrected.sha256, book.sha256);
    assert.notEqual(corrected.url, book.url);
    await identity(f.file(first.date, 'tpp'), book);
    assert.equal(f.feed.transferred.filter(url => url.endsWith('/San_Francisco.zip')).length, 1);
    await verifyPublished(f.charts);
});

test('correcting a base book during a notice cycle retains both catalogs and their exact PDF bytes', async t => {
    const f = await fixture(t);
    const [first, notice] = editions;
    const base = await f.run(first.date);
    const before = await f.run(notice.date);
    const url = `${TPP_ROOT}${first.date}/SW2.pdf`;
    const bytes = f.feed.responses.get(url);
    assert.ok(bytes);
    f.feed.responses.set(url, Buffer.from(Buffer.from(bytes).toString('latin1').replace('Approach', 'Correct!'), 'latin1'));
    const after = await f.run(notice.date);
    const oldBook = before.procedures.volumes.find(volume => volume.id === 'SW2');
    const newBook = after.procedures.volumes.find(volume => volume.id === 'SW2');
    assert.notEqual(newBook.url, oldBook.url);
    assert.equal(oldBook.sha256, base.procedures.volumes[0].sha256);
    await identity(f.file(notice.date, 'tpp'), oldBook);
    await verifyPublished(f.charts);
    await f.run(notice.date); // Automatic migration must not audit/replace the older catalog.
    await verifyPublished(f.charts);
});

// Exercise real downloads, extraction, locks, receipts, packaging, source parsing,
// PDF indexing and publication. Only GDAL rendering is replaced by one cached tile.
async function fixture(t: TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-rollover-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const feed = await rolloverFeed(root);
    t.mock.method(globalThis, 'fetch', feed.fetch); // Unknown URLs fail; no live network fallback.
    // Synthetic plates/routes have no manually reviewed real-world associations.
    const readFile = fs.readFile.bind(fs);
    const reviewed = new URL('../data/approach-associations/2026-09-03.json', import.meta.url).href;
    t.mock.method(fs, 'readFile', (file, ...args) => {
        if (file instanceof URL && file.href === reviewed) {
            return Promise.reject(Object.assign(new Error('No fixture reviews'), { code: 'ENOENT' }));
        }
        return readFile(file, ...args);
    });
    const output = path.join(root, 'dist');
    const charts = path.join(output, 'charts');
    const file = (cycle: string, name: string) => path.join(charts, cycle, name);
    async function run(today: string) {
        const prepared = await prepareProcedureCatalog({ output, today });
        await fs.mkdir(charts, { recursive: true });
        await migratePdfBooks(output);
        const groups = await discoverCharts({ today });
        for (const group of groups) for (const [region, listing] of Object.entries(group.files)) {
            assert.ok(listing.current, `discovery covers ${group.prefix}/${region} on ${today}`);
            assert.ok(listing.current.date <= today, 'future publications are not selected');
        }
        const selected: ChartGroup[] = groups.map(group => ({ ...group, files: Object.fromEntries(
            Object.entries(group.files).filter(([region]) => representative[group.prefix]?.includes(region))
        ) }));
        await downloadChartFiles(selected, output, 2);
        const raster = selected.find(group => group.prefix === 'vfr-sectional').files.San_Francisco.current;
        const source = path.join(chartSourceDirectory(path.join(charts, raster.date)), raster.extractions[0].filename);
        const cache = chartMbtilesPath(source);
        if (!await fs.stat(cache).catch(error => { if (error.code !== 'ENOENT') throw error; })) {
            await fs.mkdir(path.dirname(cache), { recursive: true });
            const png = await sharp({ create: { width: 256, height: 256, channels: 4,
                background: raster.date === editions[0].date ? '#ff0000' : '#0000ff' } }).png().toBuffer();
            const db = new DatabaseSync(cache);
            try {
                db.exec('CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB,PRIMARY KEY(zoom_level,tile_column,tile_row))');
                db.prepare('INSERT INTO tiles VALUES (0,0,0,?)').run(png);
            } finally { db.close(); }
            await writeChartBuildReceipt(source, cache);
        }
        await writeChartManifests(charts, async () => ({ bounds: [-180, -85, 180, 85], minZoom: 0, maxZoom: 0 }));
        await buildChartPackages(output);
        await buildNasrData({ output, today, routeHistorySource: feed.history });
        const procedures = await prepared.build();
        assert.ok(procedures.associations, 'current navigation must keep route-to-plate associations available');
        const supplements = await buildChartSupplements({ output, effectiveDate: procedures.effectiveDate });
        const index = await buildChartCycles(output);
        return { groups, procedures, supplements, index };
    }
    return { root, feed, output, charts, file, run };
}

async function identity(directory: string, item: { file?: string; url?: string; byteLength?: number; bytes?: number; sha256: string }) {
    const relative = item.file ?? item.url;
    assert.ok(!path.isAbsolute(relative) && !relative.includes('sources/') && !relative.includes('://'));
    const file = path.resolve(directory, relative);
    assert.equal((await fs.stat(file)).size, item.byteLength ?? item.bytes, file);
    assert.equal(await sha256File(file), item.sha256, file);
    return file;
}

// Follow every published reference, including books carried over from prior cycles.
async function verifyPublished(charts: string) {
    const { cycles } = await json(path.join(charts, 'cycles.json'));
    for (const cycle of cycles) {
        for (const kind of ['nav', 'tpp', 'mbtiles']) {
            const directory = path.join(charts, cycle, kind);
            const manifest = await json(path.join(directory, 'manifest.json')).catch(error => {
                if (error.code !== 'ENOENT') throw error;
            });
            if (!manifest) continue; // Product dates differ; every cycle need not contain every family.
            for (const item of manifest.products ?? manifest.archives ?? [manifest]) await identity(directory, item);
            if (kind === 'tpp') {
                const catalog = await json(path.join(directory, manifest.file));
                for (const volume of catalog.volumes) await identity(directory, volume);
                for (const airport of catalog.airports) for (const procedure of airport.procedures) {
                    if (!procedure.volumeTarget) continue;
                    const target = procedure.volumeTarget;
                    const volume = catalog.volumes.find(volume => volume.id === target.volumeId);
                    assert.ok(volume, `${procedure.name}: ${target.volumeId} is available`);
                    assert.ok(Number.isInteger(target.pageIndex) && target.pageIndex >= 0 && target.pageIndex < volume.pageCount);
                }
            }
        }
        const directory = path.join(charts, cycle, 'cs');
        const catalog = await json(path.join(directory, 'catalog.json'));
        for (const volume of catalog.volumes) await identity(directory, volume);
        assert.ok(catalog.airports.length > 0);
    }
    const files = await fs.readdir(path.dirname(charts), { recursive: true });
    assert.deepEqual(files.filter(file => /\.build\.lock|\.nav-build-|\.nasr-source-|\.tmp-/.test(file)), [], 'no abandoned locks or staging files');
}

test('offline full edition → change notice → next full edition survives missing inputs and interrupted publication', async t => {
    const f = await fixture(t);
    const [first, notice, next] = editions;
    const start = await f.run(first.date);
    assert.deepEqual(start.index.cycles, [first.date]);
    await verifyPublished(f.charts);
    const originalTiles = await json(f.file(first.date, 'mbtiles/manifest.json'));
    const originalNav = await fs.readFile(f.file(first.date, 'nav/manifest.json'), 'utf8');
    const originalBook = start.procedures.volumes.find(volume => volume.id === 'SW2');

    // FAA has already removed September's link while this run's pinned date is
    // still September 30. The dated XML remains available independently.
    f.feed.responses.set('https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/dtpp/search/',
        '<a href="https://aeronav.faa.gov/d-tpp/2610/xml_data/d-tpp_Metafile.xml">Oct 01&ndash;Oct 29, 2026</a>');
    const beforeBoundary = await f.run('2026-09-30');
    assert.equal(beforeBoundary.procedures.effectiveDate, first.date);
    assert.deepEqual(beforeBoundary.index.cycles, [first.date]);
    assert.deepEqual((await json(f.file(first.date, 'mbtiles/manifest.json'))).archives, originalTiles.archives);
    assert.equal(f.feed.requested.filter(url => url.endsWith('/San_Francisco.zip')).length, 2, 'dated sources are revalidated');
    assert.equal(f.feed.transferred.filter(url => url.endsWith('/San_Francisco.zip')).length, 1, 'unchanged bytes are reused');
    const previousIndex = await fs.readFile(path.join(f.charts, 'cycles.json'), 'utf8');
    const previousNav = await fs.readFile(f.file(first.date, 'nav/manifest.json'), 'utf8');
    assert.deepEqual(JSON.parse(previousNav).products, JSON.parse(originalNav).products);

    f.feed.unavailable.add(`${TPP_ROOT}${notice.date}/CN.pdf`);
    await assert.rejects(f.run(notice.date), /404/);
    assert.equal(await fs.readFile(path.join(f.charts, 'cycles.json'), 'utf8'), previousIndex);
    await verifyPublished(f.charts);
    f.feed.unavailable.clear();

    const rename = fs.rename;
    const interrupted = t.mock.method(fs, 'rename', async (from, to) => {
        if (String(to) === f.file(notice.date, 'nav/manifest.json')) throw new Error('Injected publication interruption');
        return rename(from, to);
    });
    try { await assert.rejects(f.run(notice.date), /Injected publication interruption/); }
    finally { interrupted.mock.restore(); }
    assert.equal(await fs.readFile(path.join(f.charts, 'cycles.json'), 'utf8'), previousIndex);
    assert.equal(await fs.readFile(f.file(first.date, 'nav/manifest.json'), 'utf8'), previousNav);
    await assert.rejects(fs.access(f.file(notice.date, 'nav/manifest.json')), { code: 'ENOENT' });
    await verifyPublished(f.charts);

    const carried = await f.run(notice.date);
    assert.deepEqual(carried.index.cycles, [notice.date, first.date]);
    assert.equal(carried.procedures.effectiveDate, notice.date);
    assert.deepEqual(carried.procedures.volumes.map(volume => volume.id).sort(), ['CN', 'SW2']);
    const noticeBook = carried.procedures.volumes.find(volume => volume.id === 'CN');
    assert.equal(noticeBook.url, `tpp-cn.${noticeBook.sha256}.pdf`);
    assert.equal(carried.procedures.volumes.find(volume => volume.id === 'SW2').url, `../../2026-09-03/tpp/${originalBook.url}`);
    assert.equal(carried.procedures.airports[0].procedures.find(procedure => procedure.kind === 'approach').volumeTarget.volumeId, 'CN');
    assert.equal(carried.supplements.effectiveDate, first.date);
    const nav = await json(f.file(notice.date, 'nav/manifest.json'));
    for (const source of nav.sourceArchives.filter(source => source.group !== 'CIFP')) {
        assert.equal(source.effectiveDate, ['AWY', 'PFR', 'DP', 'STAR'].includes(source.group) ? first.date : notice.date);
    }
    assert.equal(nav.sourceArchives.find(source => source.group === 'CIFP').filename, 'CIFP_261001.zip');
    assert.equal(nav.products.length, 8);
    assert.deepEqual(await fs.readdir(f.file(notice.date, 'mbtiles')), [], 'no duplicate raster edition');
    assert.deepEqual(await fs.readdir(chartSourceDirectory(path.join(f.charts, notice.date))), []);
    await assert.rejects(fs.access(f.file(notice.date, 'tpp/tpp-sw2.pdf')), { code: 'ENOENT' });
    await verifyPublished(f.charts);

    const advanced = await f.run(next.date);
    assert.equal(advanced.procedures.effectiveDate, next.date);
    assert.deepEqual(advanced.procedures.volumes.map(volume => volume.id), ['SW2'], 'old change notice is not carried forward');
    assert.equal(advanced.procedures.volumes[0].url, `tpp-sw2.${advanced.procedures.volumes[0].sha256}.pdf`);
    assert.equal(advanced.supplements.effectiveDate, next.date);
    const nextNav = await json(f.file(next.date, 'nav/manifest.json'));
    for (const source of nextNav.sourceArchives.filter(source => source.group !== 'CIFP')) assert.equal(source.effectiveDate, next.date);
    assert.equal(nextNav.sourceArchives.find(source => source.group === 'CIFP').filename, 'CIFP_261029.zip');
    assert.notEqual((await json(f.file(next.date, 'mbtiles/manifest.json'))).archives[0].sha256, originalTiles.archives[0].sha256);
    await identity(f.file(first.date, 'tpp'), originalBook);
    await verifyPublished(f.charts);
});

test('fresh change-notice install acquires the preceding base books without a preexisting cache', async t => {
    const f = await fixture(t);
    const result = await f.run(editions[1].date);
    assert.equal(result.procedures.effectiveDate, editions[1].date);
    assert.deepEqual(result.procedures.volumes.map(volume => volume.id).sort(), ['CN', 'SW2']);
    assert.ok(f.feed.requested.includes(`${TPP_ROOT}2026-09-03/SW2.pdf`));
    assert.ok(f.feed.requested.includes(`${TPP_ROOT}2026-10-01/CN.pdf`));
    assert.equal(result.supplements.effectiveDate, editions[0].date);
    // The older directory contains base artifacts only; its own catalog is not built.
    const nav = await json(f.file(editions[1].date, 'nav/manifest.json'));
    for (const product of nav.products) await identity(path.join(f.charts, editions[1].date, 'nav'), product);
    for (const volume of result.procedures.volumes) await identity(path.join(f.charts, editions[1].date, 'tpp'), volume);
    assert.ok(result.procedures.airports[0].procedures.every(procedure => procedure.volumeTarget?.pageIndex !== null));
});
