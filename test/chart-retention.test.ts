import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { buildChartCycles } from '../build-chart-cycles.ts';
import { acquireChartBuildLock } from '../lib/chart-build-lock.ts';
import { parseRetainChartCycles, pruneChartCycles } from '../lib/chart-retention.ts';

const old = '2026-07-09', base = '2026-09-03', notice = '2026-10-01', next = '2026-10-29';
const hash = 'a'.repeat(64);
const tppBook = `tpp-sw2.${hash}.pdf`, csBook = `cs-pac.${hash}.pdf`;

async function fixture(t: TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-retention-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const file = (...parts: string[]) => path.join(root, ...parts);
    const write = async (relative: string, data: unknown = 'bytes') => {
        await fs.mkdir(path.dirname(file(relative)), { recursive: true });
        await fs.writeFile(file(relative), typeof data === 'string' ? data : JSON.stringify(data));
    };
    const volume = (url: string) => ({ url, byteLength: 5, sha256: hash });
    for (const date of [old, base, next]) {
        await write(`charts/${date}/mbtiles/map.mbtiles`);
        await write(`charts/${date}/mbtiles/manifest.json`, { archives: [{ file: 'map.mbtiles', byteLength: 5 }] });
        await write(`mbtiles/${date}/sheet.mbtiles`);
        await write(`sources/${date}/charts/sheet.tif`);
        await write(`zips/${date}/sheet.zip`);
        await write(`charts/${date}/tpp/${tppBook}`);
        await write(`charts/${date}/cs/${csBook}`);
        await write(`sources/${date}/tpp/tpp-sw2.pdf`);
        await write(`sources/${date}/cs/cs-pac.pdf`);
        await write(`sources/${date}/tpp-sw2.pdf.http.json`);
        await write(`sources/${date}/cs-pac.pdf.http.json`);
    }
    for (const date of [old, base, notice, next]) {
        const bookDate = date === notice ? base : date;
        const prefix = date === notice ? `../../${base}/` : '../';
        await write(`charts/${date}/tpp/manifest.json`, { file: 'catalog.json' });
        await write(`charts/${date}/tpp/catalog.json`, { volumes: [
            volume(`${prefix}tpp/${tppBook}`), volume(`${prefix}cs/${csBook}`)
        ] });
        await write(`charts/${date}/cs/catalog.json`, { volumes: [volume(`../../${bookDate}/cs/${csBook}`)] });
        await write(`sources/${date}/tpp/d-tpp_Metafile.xml`);
        await write(`supplements/${date}.build.json`);
    }
    await write(`charts/${base}/tpp/tpp-unused.${hash}.pdf`);
    await write(`sources/${base}/tpp/tpp-unused.pdf`);
    await write(`sources/${base}/tpp-unused.pdf.http.json`);
    for (const folder of ['charts/terrain', 'charts/obstacles', 'sources/route-history', 'sources/manual']) {
        await write(`${folder}/keep.txt`);
    }
    return { root, file, write };
}

const missing = (file: string) => assert.rejects(fs.access(file), { code: 'ENOENT' });

test('keeps two raster editions and two catalog revisions, including exact cross-cycle and Pacific PDF dependencies', async t => {
    const f = await fixture(t);
    await f.write('sources/2026-12-24/charts/partial.tif');
    // An empty intervening raster directory must not count as an edition.
    await fs.mkdir(f.file('charts', notice, 'mbtiles'));
    await pruneChartCycles(f.root, 2, next);
    for (const folder of ['charts', 'sources', 'mbtiles', 'zips']) await missing(f.file(folder, old));
    for (const date of [base, next]) {
        await fs.access(f.file('charts', date, 'mbtiles/map.mbtiles'));
        await fs.access(f.file('mbtiles', date, 'sheet.mbtiles'));
        await fs.access(f.file('sources', date, 'charts/sheet.tif'));
        await fs.access(f.file('zips', date, 'sheet.zip'));
    }
    await missing(f.file('charts', base, 'tpp/manifest.json'));
    await missing(f.file('charts', base, 'cs/catalog.json'));
    for (const [family, book, source] of [['tpp', tppBook, 'tpp-sw2.pdf'], ['cs', csBook, 'cs-pac.pdf']]) {
        assert.equal(await fs.readFile(f.file('charts', base, family, book), 'utf8'), 'bytes');
        await fs.access(f.file('sources', base, family, source));
        await fs.access(f.file('sources', base, `${source}.http.json`));
    }
    await missing(f.file('charts', base, 'tpp', `tpp-unused.${hash}.pdf`));
    await missing(f.file('sources', base, 'tpp/tpp-unused.pdf'));
    await missing(f.file('sources', base, 'tpp-unused.pdf.http.json'));
    await missing(f.file('supplements', `${base}.build.json`));
    for (const folder of ['charts/terrain', 'charts/obstacles', 'sources/route-history', 'sources/manual']) {
        await fs.access(f.file(folder, 'keep.txt'));
    }
    await fs.access(f.file('sources/2026-12-24/charts/partial.tif'));
    assert.deepEqual((await buildChartCycles(f.root)).cycles, [next, notice, base]);
    const before = (await fs.readdir(f.root, { recursive: true })).sort();
    await pruneChartCycles(f.root, 2, next);
    assert.deepEqual((await fs.readdir(f.root, { recursive: true })).sort(), before);
    assert.ok(!before.some(name => name.includes('.build.lock')));
});

test('a configurable single edition releases older dependencies and both intermediate and delivery files', async t => {
    const f = await fixture(t);
    await pruneChartCycles(f.root, 1, next);
    assert.deepEqual((await buildChartCycles(f.root)).cycles, [next]);
    for (const date of [old, base, notice]) {
        for (const folder of ['charts', 'sources', 'mbtiles', 'zips']) await missing(f.file(folder, date));
    }
});

test('fewer than the requested completed editions never ages out files', async t => {
    const f = await fixture(t);
    const before = (await fs.readdir(f.root, { recursive: true })).sort();
    await pruneChartCycles(f.root, 8, next);
    assert.deepEqual((await fs.readdir(f.root, { recursive: true })).sort(), before);
});

for (const failure of ['missing-book', 'invalid-url', 'missing-archive', 'active-tiler', 'active-catalog', 'active-xml', 'symlink']) {
    test(`retention refuses ${failure} before deleting any expired files`, async t => {
        const f = await fixture(t);
        let release: (() => Promise<void>) | undefined;
        if (failure === 'missing-book') await fs.rm(f.file('charts', base, 'tpp', tppBook));
        if (failure === 'invalid-url') await f.write(`charts/${next}/tpp/catalog.json`, { volumes: [{ url: '../../../../outside.pdf' }] });
        if (failure === 'missing-archive') await fs.rm(f.file('charts', next, 'mbtiles/map.mbtiles'));
        if (failure === 'active-tiler') release = await acquireChartBuildLock(f.file('sources', old, 'charts/sheet.tif'));
        if (failure === 'active-catalog') release = await acquireChartBuildLock(f.file('charts', notice, '.tpp'));
        if (failure === 'active-xml') release = await acquireChartBuildLock(f.file('sources', old, 'tpp'));
        if (failure === 'symlink') {
            await fs.rm(f.file('sources', old, 'charts'), { recursive: true });
            await fs.symlink(f.file('sources', next, 'charts'), f.file('sources', old, 'charts'));
        }
        try { await assert.rejects(pruneChartCycles(f.root, 2, next)); }
        finally { await release?.(); }
        await fs.access(f.file('charts', old, 'mbtiles/map.mbtiles'));
        await fs.access(f.file('charts', old, 'tpp', tppBook));
        await fs.access(f.file('zips', old, 'sheet.zip'));
        assert.ok(!(await fs.readdir(f.root, { recursive: true })).some(name => name.includes('.build.lock')));
    });
}

test('validates retention counts and dates before touching output', async () => {
    for (const value of ['', '0', '-1', '1.5', '2x', 'Infinity', '9007199254740992']) {
        assert.throws(() => parseRetainChartCycles(value), /positive integer/);
    }
    assert.equal(parseRetainChartCycles('2'), 2);
    await assert.rejects(pruneChartCycles('/unused', 2, '2026-02-30'), /Invalid retention cutoff/);
    await assert.rejects(pruneChartCycles('/unused', 0, next), /positive integer/);
});

test('retention recovers dead download owners and removes expired validator, XML, and page-index caches', async t => {
    const f = await fixture(t);
    await f.write(`zips/${old}/sheet.zip.build.lock`, { pid: 2147483647, token: 'legacy' });
    await f.write(`sources/${old}/charts/sheet.tif.build.lock/2147483647-${randomUUID()}.json`, {});
    await f.write(`zips/${old}/sheet.zip.build.lock.pending-abcd/2147483647-${randomUUID()}.json`, {});
    await f.write(`sources/${old}/sheet.zip.http.json`, {});
    await f.write('supplements/afd_09JUL2026.xml', 'old XML');
    await f.write('supplements/afd_09JUL2026.xml.http.json', {});
    // A retained revision can still reference the XML of an older base edition.
    await f.write(`charts/${notice}/cs/catalog.json`, { effectiveDate: base, volumes: [
        { url: `../../${base}/cs/${csBook}`, byteLength: 5 }
    ] });
    await f.write('supplements/afd_03SEP2026.xml', 'pinned base XML');
    await f.write('supplements/afd_03SEP2026.xml.http.json', {});
    await f.write(`pdf-indexes/${'b'.repeat(64)}.tpp.json`, {});
    await f.write(`pdf-indexes/${'b'.repeat(64)}.tpp.json.build.json`, {});
    await f.write(`pdf-indexes/${hash}.tpp.json`, {});
    await pruneChartCycles(f.root, 2, next);
    await missing(f.file('zips', old));
    await missing(f.file('sources', old));
    await missing(f.file('supplements/afd_09JUL2026.xml'));
    await missing(f.file('supplements/afd_09JUL2026.xml.http.json'));
    await fs.access(f.file('supplements/afd_03SEP2026.xml'));
    await fs.access(f.file('supplements/afd_03SEP2026.xml.http.json'));
    assert.deepEqual(await fs.readdir(f.file('pdf-indexes')), [`${hash}.tpp.json`]);
});
