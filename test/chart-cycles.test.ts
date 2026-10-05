import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildChartCycles } from '../build-chart-cycles.ts';

test('cycles.json lists only dated directories, newest first, and refreshes removed editions', async t => {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-chart-cycles-'));
    t.after(() => fs.rm(output, { recursive: true, force: true }));
    const root = path.join(output, 'charts');
    for (const date of ['2026-09-03', '2026-10-01', '2026-09-31', 'route-history', 'obstacles']) {
        await fs.mkdir(path.join(root, date), { recursive: true });
    }
    await fs.writeFile(path.join(root, '2026-11-26'), 'not a directory');
    await fs.symlink(path.join(root, '2026-09-03'), path.join(root, '2026-12-24'));
    const index = await buildChartCycles(output);
    assert.equal(index.schemaVersion, 1);
    assert.ok(Number.isFinite(Date.parse(index.generatedAt)));
    assert.deepEqual(index.cycles, ['2026-10-01', '2026-09-03']);
    assert.deepEqual(index.rasterCycles, []);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'cycles.json'), 'utf8')), index);
    await fs.rm(path.join(root, '2026-10-01'), { recursive: true });
    assert.deepEqual((await buildChartCycles(output)).cycles, ['2026-09-03']);
});

test('raster availability follows published manifests and changes without a new dated directory', async t => {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-raster-cycles-'));
    t.after(() => fs.rm(output, { recursive: true, force: true }));
    const root = path.join(output, 'charts');
    for (const date of ['2026-09-03', '2026-10-01']) await fs.mkdir(path.join(root, date, 'mbtiles'), { recursive: true });
    const manifest = path.join(root, '2026-09-03/mbtiles/manifest.json');
    await fs.writeFile(manifest, '{}');
    const first = await buildChartCycles(output);
    assert.deepEqual(first.rasterCycles, ['2026-09-03']);
    assert.deepEqual(await buildChartCycles(output), first, 'an unchanged inventory preserves its identity');
    await fs.writeFile(path.join(root, '2026-10-01/chart-manifest.json'), '{}');
    assert.deepEqual((await buildChartCycles(output)).rasterCycles, ['2026-10-01', '2026-09-03']);
    await fs.rm(manifest);
    assert.deepEqual((await buildChartCycles(output)).rasterCycles, ['2026-10-01']);
});

test('all supported raster layouts are discovered but directories, symlinks and partial files are excluded', async t => {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-raster-layouts-'));
    t.after(() => fs.rm(output, { recursive: true, force: true }));
    const root = path.join(output, 'charts/2026-09-03');
    for (const name of ['mbtiles/manifest.json', 'mbtiles/packages/manifest.json', 'mbtiles/chart-manifest.json', 'chart-manifest.json']) {
        const file = path.join(root, name);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, '{}');
        assert.deepEqual((await buildChartCycles(output)).rasterCycles, ['2026-09-03'], name);
        await fs.rm(file);
    }
    await fs.mkdir(path.join(root, 'mbtiles/manifest.json'));
    await fs.writeFile(path.join(root, 'chart-manifest.json.part'), '{}');
    await fs.symlink(path.join(root, 'chart-manifest.json.part'), path.join(root, 'chart-manifest.json'));
    assert.deepEqual((await buildChartCycles(output)).rasterCycles, []);
});
