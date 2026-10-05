import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildFingerprint } from '../lib/build-cache.ts';
import { cachedGlideSource, withGlideSourceCache } from '../lib/glide-download.ts';
import { downloadGlideCover, glideNativeWindow, type CoverService } from '../lib/glide-raster-download.ts';
import { createDefaultGlideSources } from '../lib/glide-defaults.ts';
import { terrainCommand } from '../lib/terrain-raster.ts';
import { expandBounds, GLIDE_RULES, type Bounds } from '../lib/glide-model.ts';
import { GdalPool } from '../lib/gdal.ts';
import { downloadFile, DownloadHttpError } from '../lib/http-download.ts';

let hasGdal = true;
try {
    execFileSync('ogr2ogr', ['--version'], { stdio: 'ignore' });
    execFileSync('gdal_create', ['--version'], { stdio: 'ignore' });
} catch { hasGdal = false; }
const service: CoverService = { endpoint: 'https://example.test/wcs', coverage: 'landcover',
    time: '2025-01-01T00:00:00.000Z', revision: 'fixture', srs: 'EPSG:5070',
    origin: [-2415570, 3314790], spacing: [30, -30], extent: [-2415585, 164805, 2384415, 3314805] };
const bounds: Bounds = [-98, 26, -97.995, 26.005];
const description = `<CoverageDescription xmlns="http://www.opengis.net/wcs" xmlns:gml="http://www.opengis.net/gml">
    <CoverageOffering><name>cover</name><domainSet><spatialDomain><gml:RectifiedGrid srsName="EPSG:5070">
    <gml:limits><gml:GridEnvelope><gml:low>0 0</gml:low><gml:high>159999 104999</gml:high></gml:GridEnvelope></gml:limits>
    <gml:origin><gml:pos>-2415570 3314790</gml:pos></gml:origin><gml:offsetVector>30 0</gml:offsetVector>
    <gml:offsetVector>0 -30</gml:offsetVector></gml:RectifiedGrid></spatialDomain><temporalDomain>
    <gml:timePosition>2025-01-01T00:00:00.000Z</gml:timePosition></temporalDomain></domainSet></CoverageOffering></CoverageDescription>`;

async function raster(directory: string, window: Bounds, code = 81): Promise<Buffer> {
    const file = path.join(directory, 'fixture.tif');
    await terrainCommand('gdal_create', ['-q', '-of', 'GTiff', '-ot', 'Byte', '-burn', String(code), '-a_nodata', '255',
        '-outsize', String((window[2] - window[0]) / 30), String((window[3] - window[1]) / 30),
        '-a_ullr', String(window[0]), String(window[3]), String(window[2]), String(window[1]), '-a_srs', 'EPSG:5070', file]);
    return fs.readFile(file);
}

test('offshore regions outside the published grid make no GetCoverage request or assessed coverage',
    { skip: hasGdal ? false : 'Requires GDAL' }, async t => {
        const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-offshore-'));
        t.after(() => fs.rm(cache, { recursive: true, force: true }));
        const requests: string[] = [];
        t.mock.method(globalThis, 'fetch', async (url: string) => {
            requests.push(url);
            assert.equal(new URL(url).searchParams.get('request'), 'DescribeCoverage');
            return new Response(description);
        });
        const messages: string[] = [];
        const provider = await createDefaultGlideSources(cache, { concurrency: 2, log: message => messages.push(message) });
        t.after(() => provider.close());
        const area = { id: 'conus-w125-n32', bounds: [-125, 32, -124, 33] as Bounds,
            coverageBounds: [-125.2, 31.8, -123.8, 33.2] as Bounds };
        const results = await Promise.all([provider.load(area, 0, 2), provider.load({ ...area, id: 'second' }, 1, 2)]);
        assert.deepEqual(results, [undefined, undefined]);
        assert.equal(requests.length, 2);
        assert.ok(messages.some(message => message.includes('outside published MRLC landcover grid; left unassessed')));
    });

test('automatic cover rejection resumes from its receipt without rebuilding masks or acquiring DEM/hazards',
    { skip: hasGdal ? false : 'Requires GDAL' }, async t => {
        const output = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-precheck-'));
        t.after(() => fs.rm(output, { recursive: true, force: true }));
        const pool = await GdalPool.create(1);
        t.after(() => pool.close());
        await pool.run(async () => {
            const window = await glideNativeWindow(expandBounds(bounds, GLIDE_RULES.analysisHaloM + 100), service, output);
            const bytes = await raster(output, window, 11);
            let downloads = 0;
            t.mock.method(globalThis, 'fetch', async (url: string) => {
                const request = new URL(url).searchParams.get('request');
                if (request === 'DescribeCoverage') return new Response(description);
                assert.equal(request, 'GetCoverage', 'Rejected cover must not acquire other source families');
                downloads++;
                return new Response(Uint8Array.from(bytes));
            });
            const provider = await createDefaultGlideSources(output, { log: () => {} });
            t.after(() => provider.close());
            const area = { id: 'fixture', bounds, coverageBounds: expandBounds(bounds, GLIDE_RULES.inventoryHaloM + 10) };
            const first = await provider.load(area, 0, 1);
            assert.equal(first && 'screenedOut' in first && first.screenedOut, 'cover');
            const automatic = path.join(output, 'glide-cache', 'automatic');
            const masks: string[] = [];
            for (const file of await fs.readdir(automatic)) if (file.endsWith('.tif.json')) {
                const asset = JSON.parse(await fs.readFile(path.join(automatic, file), 'utf8'));
                if (asset.name === 'landcover eligibility mask') masks.push(asset.file);
            }
            assert.equal(masks.length, 1);
            await fs.rm(masks[0]);
            assert.deepEqual(await provider.load(area, 0, 1), first);
            await assert.rejects(fs.stat(masks[0]), { code: 'ENOENT' });
            assert.equal(downloads, 1);
        });
    });

test('concurrent source builds share work and failures, then permit a clean retry and explicit refresh', async t => {
    const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-source-sharing-'));
    t.after(() => fs.rm(cache, { recursive: true, force: true }));
    const description = { name: 'Fixture', date: '2026-01-01', attribution: 'Fixture' };
    let calls = 0;
    const failing = async (file: string) => {
        calls++;
        await fs.writeFile(file, 'partial');
        throw new Error('Fixture interrupted download');
    };
    const failed = await Promise.allSettled(Array.from({ length: 4 }, () =>
        cachedGlideSource(cache, { fixture: 1 }, description, 'tif', failing)));
    assert.equal(calls, 1);
    for (const result of failed) {
        assert.equal(result.status, 'rejected');
        if (result.status === 'rejected') assert.match(result.reason.message, /Fixture interrupted download/);
    }
    assert.deepEqual(await fs.readdir(path.join(cache, 'automatic')), []);
    const build = async (file: string) => { calls++; await fs.writeFile(file, `snapshot-${calls}`); };
    const recovered = await Promise.all(Array.from({ length: 4 }, () =>
        cachedGlideSource(cache, { fixture: 1 }, description, 'tif', build)));
    assert.equal(calls, 2);
    for (const asset of recovered) assert.deepEqual(asset, recovered[0]);
    const [cached, refreshed, alsoRefreshed] = await Promise.all([
        cachedGlideSource(cache, { fixture: 1 }, description, 'tif', build),
        cachedGlideSource(cache, { fixture: 1 }, description, 'tif', build, true),
        cachedGlideSource(cache, { fixture: 1 }, description, 'tif', build, true)
    ]);
    assert.equal(calls, 3);
    assert.equal(cached.sha256, recovered[0].sha256);
    assert.notEqual(refreshed.sha256, cached.sha256);
    assert.deepEqual(refreshed, alsoRefreshed);
});

test('per-build verification reuse detects same-size edits, deletion, and explicit refresh', async t => {
    const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-source-verification-'));
    t.after(() => fs.rm(cache, { recursive: true, force: true }));
    await withGlideSourceCache(async () => {
        let builds = 0;
        const load = (refresh = false) => cachedGlideSource(cache, { fixture: 'verification' },
            { name: 'Fixture', date: '2026-01-01', attribution: 'Fixture' }, 'tif',
            async file => { await fs.writeFile(file, `valid${++builds}`); }, refresh);
        const first = await load();
        await load(); await load();
        assert.equal(builds, 1);
        const stat = await fs.stat(first.file);
        await fs.writeFile(first.file, 'broken');
        await fs.utimes(first.file, stat.atime, stat.mtime);
        const repaired = await load();
        assert.equal(builds, 2, 'same length and restored mtime cannot hide changed content');
        assert.notEqual(repaired.sha256, first.sha256);
        await fs.rm(first.file);
        await load();
        assert.equal(builds, 3);
        await load(true);
        assert.equal(builds, 4);
    });
});

test('boundary cover windows clip to the original pixel grid and retry HTTP-200 XML before accepting a TIFF',
    { skip: hasGdal ? false : 'Requires GDAL' }, async t => {
        const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-cover-edge-'));
        t.after(() => fs.rm(cache, { recursive: true, force: true }));
        const window = await glideNativeWindow(bounds, service, cache);
        const clipped: Bounds = [window[0] + 60, window[1], window[2], window[3]];
        const bytes = await raster(cache, clipped);
        const edge = { ...service, extent: [clipped[0], service.extent[1], service.extent[2], service.extent[3]] as Bounds };
        let attempts = 0;
        t.mock.method(globalThis, 'fetch', async (url: string) => {
            const query = new URL(url).searchParams;
            assert.equal(query.get('bbox'), clipped.join(','));
            assert.equal(query.get('resx'), '30');
            return ++attempts === 1 ? new Response('<ServiceExceptionReport><ServiceException>Temporary reader failure</ServiceException></ServiceExceptionReport>')
                : new Response(Uint8Array.from(bytes));
        });
        const asset = await downloadGlideCover('landcover', edge, bounds, cache);
        assert.ok(asset);
        assert.equal(attempts, 2);
        assert.deepEqual(await fs.readFile(asset.file), bytes);
        assert.equal(await downloadGlideCover('landcover', edge, bounds, cache).then(value => value?.sha256), asset.sha256);
        assert.equal(attempts, 2, 'verified source is reused');
    });

test('in-bounds service exceptions remain failures after bounded retries and leave no reusable source',
    { skip: hasGdal ? false : 'Requires GDAL' }, async t => {
        const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-cover-error-'));
        t.after(() => fs.rm(cache, { recursive: true, force: true }));
        let attempts = 0;
        t.mock.method(globalThis, 'fetch', async () => {
            attempts++;
            return new Response('<ServiceExceptionReport><ServiceException>No raster data found in the request</ServiceException></ServiceExceptionReport>');
        });
        await assert.rejects(downloadGlideCover('landcover', service, bounds, cache), /MRLC landcover returned a non-TIFF response: No raster data found/);
        assert.equal(attempts, 3);
        assert.ok((await fs.readdir(path.join(cache, 'automatic'))).every(name => !name.endsWith('.tif') && !name.endsWith('.tif.json')));
    });

test('MRLC retries a temporary 404 for the same URL and caches only the validated raster',
    { skip: hasGdal ? false : 'Requires GDAL' }, async t => {
        const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-cover-404-'));
        t.after(() => fs.rm(cache, { recursive: true, force: true }));
        const window = await glideNativeWindow(bounds, service, cache), bytes = await raster(cache, window);
        const urls: string[] = [];
        t.mock.method(globalThis, 'fetch', async (url: string) => {
            urls.push(url);
            return urls.length === 1 ? new Response('Temporary coverage failure', { status: 404 }) :
                new Response(Uint8Array.from(bytes));
        });
        const result = await downloadGlideCover('landcover', service, bounds, cache);
        assert.ok(result);
        assert.equal(urls.length, 2);
        assert.equal(urls[0], urls[1], 'retry keeps the exact source window and date');
        assert.deepEqual(await fs.readFile(result.file), bytes);
        assert.equal((await downloadGlideCover('landcover', service, bounds, cache))?.sha256, result.sha256);
        assert.equal(urls.length, 2, 'restart reuses the successful verified download');
    });

test('MRLC persistent 404 stops after three attempts without a reusable source',
    { skip: hasGdal ? false : 'Requires GDAL' }, async t => {
        const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-cover-404-permanent-'));
        t.after(() => fs.rm(cache, { recursive: true, force: true }));
        let attempts = 0;
        t.mock.method(globalThis, 'fetch', async () => { attempts++; return new Response('Not found', { status: 404 }); });
        await assert.rejects(downloadGlideCover('shrubHeight', service, bounds, cache), error => {
            assert.ok(error instanceof DownloadHttpError);
            assert.equal(error.status, 404);
            return true;
        });
        assert.equal(attempts, 3);
        assert.ok((await fs.readdir(path.join(cache, 'automatic'))).every(name => !name.endsWith('.tif') && !name.endsWith('.tif.json')));
    });

test('ordinary file 404 retains fail-fast and explicit skip behavior', async t => {
    const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'download-404-'));
    t.after(() => fs.rm(cache, { recursive: true, force: true }));
    let attempts = 0;
    const options = { userAgent: 'fixture', logger: { log() {}, warn() {} },
        fetch: (async () => { attempts++; return new Response('Not found', { status: 404 }); }) as typeof fetch };
    const url = 'https://example.test/missing.tif', file = path.join(cache, 'missing.tif');
    await assert.rejects(downloadFile(url, file, options), error => {
        assert.ok(error instanceof DownloadHttpError); assert.equal(error.status, 404); assert.equal(error.url, url); return true;
    });
    assert.equal(attempts, 1);
    assert.deepEqual(await downloadFile(url, file, { ...options, skipNotFound: true }), { available: false });
    assert.equal(attempts, 2);
});

test('adding grid bounds preserves source identity and reuses existing larger-window checkpoints',
    { skip: hasGdal ? false : 'Requires GDAL' }, async t => {
        const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-cover-resume-'));
        t.after(() => fs.rm(cache, { recursive: true, force: true }));
        const previousBounds: Bounds = [-98.01, 25.99, -97.98, 26.02];
        const window = await glideNativeWindow(previousBounds, service, cache);
        const bytes = await raster(cache, window);
        const { extent: _extent, ...legacyService } = service;
        const inputs = { builder: 1, service: legacyService, window };
        const old = await cachedGlideSource(cache, inputs, { name: 'legacy cover', date: '2025-01-01', attribution: 'Fixture' },
            'tif', file => fs.writeFile(file, bytes));
        t.mock.method(globalThis, 'fetch', async () => { assert.fail('A matching old source must not be downloaded again'); });
        const reused = await downloadGlideCover('landcover', service, bounds, cache, false, previousBounds);
        assert.equal(reused?.file, old.file);
        assert.equal(path.basename(reused!.file), `${buildFingerprint(inputs)}.tif`);
        assert.equal((await downloadGlideCover('landcover', service, previousBounds, cache))?.file, old.file);
    });
