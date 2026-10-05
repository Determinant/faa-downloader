import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildFingerprint, writeCachedJson } from '../lib/build-cache.ts';
import { GLIDE_VERSION, glideChunks, type Bounds, type GlideLandingArea } from '../lib/glide-model.ts';
import { GlidePreviewData, previewBounds } from '../lib/glide-preview.ts';
import { GlidePreviewSamples, previewLabels } from '../lib/glide-preview-data.ts';

test('preview reads nearby committed areas, preserves holes, and honors newer rejections', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-preview-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const cache = path.join(root, 'glide-cache', `analysis-v${GLIDE_VERSION}`);
    const name = 'conus-w98-n25--784-200.json';
    const area: GlideLandingArea = [[-97970000, 25050000, -97910000, 25050000, 200, 3000, 100, 2], [
        [-97980000, 25020000, 100000, 0, 0, 80000, -100000, 0],
        [-97960000, 25060000, 10000, 0, 0, 10000, -10000, 0],
    ], 1];
    const candidate = path.join(cache, 'area-chunks', name);
    const key = buildFingerprint({ fixture: 1 });
    await writeCachedJson(candidate, `${candidate}.build.json`, key, { areas: [area], screening: null });
    const data = new GlidePreviewData(root);
    const bounds = previewBounds('-98,25,-97.875,25.125');
    const result = await data.view(bounds, 12);
    assert.equal(result.features.length, 1);
    assert.deepEqual(result.coverage[0].bounds, bounds, 'negative longitude parses correctly');
    assert.equal(result.features[0].geometry.coordinates.length, 2, 'excluded hole remains');
    assert.deepEqual(result.features[0].geometry.coordinates[0][0], [-97.98, 25.02]);
    assert.equal((await data.view([-110, 35, -109.9, 35.1], 12)).features.length, 0);
    assert.equal((await data.view(bounds, 5)).meta.mode, 'overview');
    const rejected = path.join(cache, 'ground-rejections', name);
    await writeCachedJson(rejected, `${rejected}.build.json`, key, { areas: [], screening: null });
    const later = new Date(Date.now() + 1000); await fs.utimes(`${rejected}.build.json`, later, later);
    assert.equal((await new GlidePreviewData(root).view(bounds, 12)).features.length, 0);
    // A write not yet committed by its receipt cannot invent an assessed chunk.
    await fs.rm(rejected); await fs.rm(`${rejected}.build.json`);
    await fs.writeFile(candidate, JSON.stringify({ areas: [] }));
    const incomplete = await new GlidePreviewData(root).view(bounds, 12);
    assert.equal(incomplete.features.length, 0);
    assert.equal(incomplete.coverage.length, 0);
    assert.equal(incomplete.meta.pendingChunks, 1);
});

test('preview rejects malformed or unbounded map queries', () => {
    for (const value of [null, '', '-98,,0,1', '-98,25,-99,26', '-190,25,-98,26', '-98,25,Infinity,26']) {
        assert.throws(() => previewBounds(value), /bbox/);
    }
});

test('preview indexes custom region checkpoints with signed chunk coordinates', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-preview-custom-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const cases: [string, Bounds][] = [
        ['regional-pilot', [-98, 25, -97.875, 25.125]],
        ['survey-2026-10', [-98, -25, -97.875, -24.875]],
        ['eastern-pilot', [98, 25, 98.125, 25.125]],
    ];
    for (const [id, bounds] of cases) {
        const [chunk] = glideChunks({ id, bounds, coverageBounds: bounds, sources: {} as never });
        const x = Math.round((bounds[0] + 0.02) * 1e6), y = Math.round((bounds[1] + 0.02) * 1e6);
        const area: GlideLandingArea = [[x + 1000, y + 5000, x + 9000, y + 5000, 200, 2500, 100, 2, 0, 0],
            [[x, y, 10000, 0, 0, 10000, -10000, 0]], 0];
        const put = async (family: string, areas: GlideLandingArea[]) => {
            const file = path.join(root, 'glide-cache', `analysis-v${GLIDE_VERSION}`, family, `${chunk.id}.json`);
            await writeCachedJson(file, `${file}.build.json`, buildFingerprint({ chunk }), { areas });
            return `${file}.build.json`;
        };
        await put('area-chunks', [area]);
        const result = await new GlidePreviewData(root).view(bounds, 12);
        assert.equal(result.features.length, 1, id);
        assert.deepEqual(result.coverage.map(c => c.bounds), [bounds], id);
        const receipt = await put('ground-rejections', []);
        const later = new Date(Date.now() + 1000); await fs.utimes(receipt, later, later);
        const rejected = await new GlidePreviewData(root).view(bounds, 12);
        assert.equal(rejected.features.length, 0);
        assert.equal(rejected.meta.visibleChunks, 1, 'custom rejected chunks remain assessed');
    }
});


test('preview keeps previous analysis separate from current rebuild checkpoints', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-preview-versions-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const name = 'conus-w98-n25--784-200.json', key = buildFingerprint({ fixture: 'versions' });
    const area: GlideLandingArea = [[-97970000, 25050000, -97910000, 25050000, 200, 3000, 100, 2],
        [[-97980000, 25020000, 100000, 0, 0, 80000, -100000, 0]], 0];
    const put = async (version: number, areas: GlideLandingArea[]) => {
        const file = path.join(root, 'glide-cache', `analysis-v${version}`, 'area-chunks', name);
        await writeCachedJson(file, `${file}.build.json`, key, { areas });
    };
    await put(14, [area]);
    const bounds = previewBounds('-98,25,-97.875,25.125');
    assert.equal((await new GlidePreviewData(root).view(bounds, 12)).features.length, 0);
    const prior = await new GlidePreviewData(root, 14).view(bounds, 12);
    assert.equal(prior.features.length, 1); assert.equal(prior.meta.version, 14);
    await put(GLIDE_VERSION, []);
    const current = await new GlidePreviewData(root).view(bounds, 12);
    assert.equal(current.features.length, 0);
    assert.equal(current.meta.visibleChunks, 1, 'completed empty result differs from not yet analyzed');
    assert.equal(current.meta.version, GLIDE_VERSION);
});

test('overview counts committed receipts and keeps unfinished or replaced files pending', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-preview-pending-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const file = path.join(root, `glide-cache/analysis-v${GLIDE_VERSION}/area-chunks/conus-w98-n25--784-200.json`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ areas: [] }));
    const data = new GlidePreviewData(root), bounds: Bounds = [-98, 25, -97.875, 25.125];
    const pending = async () => {
        for (const zoom of [5, 12]) {
            const view = await data.view(bounds, zoom);
            assert.equal(view.meta.visibleChunks, 0); assert.equal(view.meta.pendingChunks, 1);
            assert.equal(view.coverage.length, 0);
        }
    };
    await pending();
    await writeCachedJson(file, `${file}.build.json`, buildFingerprint('first'), { areas: [] });
    assert.equal((await data.view(bounds, 5)).meta.visibleChunks, 1, 'completed empty results count');
    await fs.writeFile(file, JSON.stringify({ areas: [], replacement: true }));
    const later = new Date((await fs.stat(`${file}.build.json`)).mtimeMs + 1000);
    await fs.utimes(file, later, later);
    await pending();
    await fs.writeFile(`${file}.build.json`, '{');
    await pending();
    await writeCachedJson(file, `${file}.build.json`, buildFingerprint('second'), { areas: [] });
    assert.equal((await data.view(bounds, 5)).meta.visibleChunks, 1, 'a repaired commit becomes available');
});

test('concurrent preview requests share reads and account for each cached file once', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-preview-concurrent-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const file = path.join(root, `glide-cache/analysis-v${GLIDE_VERSION}/area-chunks/conus-w98-n25--784-200.json`);
    const area: GlideLandingArea = [[-97970000, 25050000, -97910000, 25050000, 200, 3000, 100, 2],
        [[-97980000, 25020000, 100000, 0, 0, 80000, -100000, 0]], 0];
    const data = new GlidePreviewData(root), bounds: Bounds = [-98, 25, -97.875, 25.125];
    const read = fs.readFile; let reads = 0;
    t.mock.method(fs, 'readFile', (...args: Parameters<typeof fs.readFile>) => { if (args[0] === file) reads++; return read.apply(fs, args); });
    for (const count of [1, 3]) {
        await writeCachedJson(file, `${file}.build.json`, buildFingerprint(count), { areas: Array(count).fill(area) });
        const before = reads;
        const views = await Promise.all(Array.from({ length: 8 }, () => data.view(bounds, 12)));
        assert.ok(views.every(view => view.features.length === count));
        assert.equal(reads - before, 1, 'one geometry read for overlapping requests');
        assert.equal((data as any).cacheBytes, (await fs.stat(file)).size);
        await data.view(bounds, 12); assert.equal(reads - before, 1, 'subsequent requests reuse the cached geometry');
    }
});

test('sample views load only the selected file and catalog metadata refreshes independently', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-preview-samples-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const directory = path.join(root, 'glide-preview/samples'); await fs.mkdir(directory, { recursive: true });
    const sample = { title: 'Fixture', center: [25, -98], zoom: 12, generatedAt: '2026-01-01', version: 20, features: [] };
    const put = (id: string, title: string) => fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify({ ...sample, id, title }));
    await put('one', 'First'); await put('two', 'Second');
    const catalog = new GlidePreviewSamples(root), data = new GlidePreviewData(root, GLIDE_VERSION, catalog);
    const read = fs.readFile, reads: string[] = [];
    t.mock.method(fs, 'readFile', (...args: Parameters<typeof fs.readFile>) => { reads.push(String(args[0])); return read.apply(fs, args); });
    assert.equal((await catalog.list()).length, 2);
    reads.length = 0;
    assert.equal((await catalog.list()).length, 2); assert.deepEqual(reads, [], 'unchanged metadata avoids reparsing geometry');
    await fs.writeFile(path.join(directory, 'two.json'), '{');
    const view = await data.view([-98, 25, -97.875, 25.125], 12, 'one');
    assert.equal(view.meta.version, 20);
    assert.deepEqual(reads, [path.join(directory, 'one.json')], 'an unrelated incomplete sample does not break the selected view');
    assert.equal((await catalog.list()).length, 1);
    await put('two', 'Second updated');
    assert.equal((await catalog.list()).find(s => s.id === 'two')?.title, 'Second updated');
    await assert.rejects(data.view([-98, 25, -97.875, 25.125], 12, '../one'), /Invalid saved sample ID/);
});

test('preview labels preserve historical rules and use the current engine thresholds', () => {
    assert.equal(previewLabels(14).preferred, 'At least one 3,000 ft fit');
    assert.equal(previewLabels(15).preferred, 'At least one 2,000 ft fit');
    assert.equal(previewLabels(19).fallback, 'At least one 1,500 ft fit');
    assert.equal(previewLabels(20).fallback, 'Measured fits · 600+ ft × 60+ ft');
    assert.deepEqual(previewLabels(GLIDE_VERSION), previewLabels(20));
});
