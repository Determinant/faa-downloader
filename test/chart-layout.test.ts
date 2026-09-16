import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { flattenChartPackages } from '../lib/chart-package-layout.ts';
import { chartCacheDirectory, chartMbtilesPath } from '../lib/chart-paths.ts';
import { sha256File, writeChartBuildReceipt, writeChartManifests } from '../lib/chart-tiler.ts';

async function fixture(t: TestContext, layout: 'flat' | 'nested' = 'nested') {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-delivery-layout-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const charts = path.join(root, 'charts');
    const cycle = path.join(charts, '2026-09-03');
    const delivery = path.join(cycle, 'mbtiles');
    const cache = path.join(root, 'mbtiles', '2026-09-03');
    const legacy = path.join(delivery, 'packages');
    await fs.mkdir(legacy, { recursive: true });
    const source = path.join(cycle, 'ifr-enroute-low-l13.tif');
    const sheet = 'ifr-enroute-low-l13.mbtiles';
    const oldDirectory = layout === 'flat' ? cycle : delivery;
    const oldSheet = path.join(oldDirectory, sheet);
    await fs.writeFile(source, 'source TIFF');
    await fs.writeFile(path.join(cycle, 'original.pdf'), 'original PDF');
    await fs.writeFile(oldSheet, 'verified sheet');
    const receipt = await writeChartBuildReceipt(source, oldSheet);
    await fs.writeFile(path.join(oldDirectory, 'chart-manifest.json'), '{}');
    const bytes = Buffer.from('immutable package');
    const temporary = path.join(root, 'fixture');
    await fs.writeFile(temporary, bytes);
    const sha256 = await sha256File(temporary);
    const id = 'ifr-low-z0-r0-0-0';
    const file = `${id}-${sha256}.mbtiles`;
    await fs.rename(temporary, path.join(legacy, file));
    const manifest = { schemaVersion: 2, packagingVersion: 1, archives: [{ id, file, sha256, byteLength: bytes.length }] };
    await fs.writeFile(path.join(legacy, 'manifest.json'), JSON.stringify(manifest));
    return { root, charts, cycle, delivery, cache, legacy, source, sheet, oldSheet, receipt, file, manifest };
}

const metadata = async () => ({ bounds: [-122, 40, -102, 49] as [number, number, number, number], minZoom: 4, maxZoom: 11 });

for (const layout of ['flat', 'nested'] as const) for (const interrupted of [false, true]) {
    test(`migrates ${layout} caches${interrupted ? ' after an interrupted move' : ''} without changing artifacts`, async t => {
        const f = await fixture(t, layout);
        if (interrupted) {
            await fs.mkdir(f.cache, { recursive: true });
            await fs.rename(f.oldSheet, path.join(f.cache, f.sheet));
            await fs.link(path.join(f.legacy, f.file), path.join(f.delivery, f.file));
        }
        assert.equal(chartCacheDirectory(f.cycle), f.cache);
        assert.equal(chartMbtilesPath(f.source), path.join(f.cache, f.sheet));
        await writeChartManifests(f.charts, metadata);
        assert.deepEqual((await fs.readdir(f.delivery)).sort(), [f.file, 'manifest.json'].sort());
        assert.deepEqual((await fs.readdir(f.cache)).sort(), ['chart-manifest.json', f.sheet, `${f.sheet}.build.json`].sort());
        assert.equal(await fs.readFile(path.join(f.cache, f.sheet), 'utf8'), 'verified sheet');
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.cache, `${f.sheet}.build.json`), 'utf8')), f.receipt);
        const build = JSON.parse(await fs.readFile(path.join(f.cache, 'chart-manifest.json'), 'utf8'));
        assert.equal(build.charts[0].file, f.sheet);
        assert.equal(build.charts[0].sha256, f.receipt.output.sha256);
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.delivery, 'manifest.json'), 'utf8')), f.manifest);
        assert.equal(await fs.readFile(f.source, 'utf8'), 'source TIFF');
        assert.equal(await fs.readFile(path.join(f.cycle, 'original.pdf'), 'utf8'), 'original PDF');
        assert.deepEqual((await fs.readdir(f.cycle)).sort(), [path.basename(f.source), 'mbtiles', 'original.pdf'].sort());
        await writeChartManifests(f.charts, metadata);
        assert.deepEqual((await fs.readdir(f.delivery)).sort(), [f.file, 'manifest.json'].sort());
    });
}

test('resumes cleanup after the flat manifest was published', async t => {
    const f = await fixture(t);
    await fs.rename(path.join(f.legacy, f.file), path.join(f.delivery, f.file));
    await fs.rename(path.join(f.legacy, 'manifest.json'), path.join(f.delivery, 'manifest.json'));
    await flattenChartPackages(f.delivery);
    await assert.rejects(fs.access(f.legacy), /ENOENT/);
    assert.equal(await sha256File(path.join(f.delivery, f.file)), f.manifest.archives[0].sha256);
});

test('rejects conflicting or damaged files without publishing the flat index', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.delivery, f.file), 'conflicting data');
    await assert.rejects(flattenChartPackages(f.delivery), /Conflicting package/);
    await assert.rejects(fs.access(path.join(f.delivery, 'manifest.json')), /ENOENT/);
    assert.equal(await fs.readFile(path.join(f.delivery, f.file), 'utf8'), 'conflicting data');
    await fs.writeFile(path.join(f.legacy, f.file), 'damaged package');
    await assert.rejects(flattenChartPackages(f.delivery), /Corrupt package/);
    await fs.access(path.join(f.legacy, 'manifest.json'));
});

test('does not relocate sheets while the old packager holds its lock', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.delivery, 'packages.build.lock'), JSON.stringify({ pid: process.pid, token: 'active' }));
    await assert.rejects(writeChartManifests(f.charts, metadata), /already in progress/);
    assert.equal(await fs.readFile(path.join(f.delivery, f.sheet), 'utf8'), 'verified sheet');
    await assert.rejects(fs.access(path.join(f.cache, f.sheet)), /ENOENT/);
});
