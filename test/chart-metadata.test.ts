import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { parseChartMetadata, readChartMetadata } from '../lib/chart-metadata.ts';
import { buildChartPackages } from '../build-chart-packages.ts';
import {
    chartCutlineForFilename, tileMbtilesFromTiff, writeChartManifests
} from '../lib/chart-tiler.ts';

const execFileAsync = promisify(execFile);
const metadata = {
    bounds: '-122.1471747,43.9849979,-102.5427588,49.2822198',
    minzoom: '4',
    maxzoom: '11'
};

function gdalInfo(fields: Record<string, unknown> = {}) {
    return { driverShortName: 'MBTiles', metadata: { '': { ...metadata, ...fields } } };
}

test('reads archive extents and zooms rather than chart-family defaults', () => {
    assert.deepEqual(parseChartMetadata(gdalInfo()), {
        bounds: [-122.1471747, 43.9849979, -102.5427588, 49.2822198],
        minZoom: 4,
        maxZoom: 11
    });
    // Honolulu's inset has a finer native level than other Sectionals.
    assert.equal(parseChartMetadata(gdalInfo({ maxzoom: '13' })).maxZoom, 13);
    assert.equal(parseChartMetadata(gdalInfo({ minzoom: '0' })).minZoom, 0);
});

test('rejects missing or invalid archive metadata', () => {
    for (const info of [null, {}, { ...gdalInfo(), driverShortName: 'GTiff' }]) {
        assert.throws(() => parseChartMetadata(info), /metadata/);
    }
    for (const fields of [
        { minzoom: undefined }, { minzoom: '' }, { minzoom: null },
        { minzoom: '-1' }, { maxzoom: '25' }, { maxzoom: '11.5' },
        { maxzoom: 'NaN' }, { maxzoom: '3' },
        { bounds: undefined }, { bounds: '-120,,10,40' },
        { bounds: '-120,20,10,NaN' }, { bounds: '-120,20,10,Infinity' },
        { bounds: '-120,40,10,20' }, { bounds: '-120,20,10,91' },
        { bounds: '170,20,-170,40' }, { bounds: '181,20,182,40' }
    ]) {
        assert.throws(() => parseChartMetadata(gdalInfo(fields)), /MBTiles/);
    }
});

test('clips pixel-aligned antimeridian extents to their world edge', () => {
    assert.deepEqual(parseChartMetadata(gdalInfo({ bounds: '170,51,180.0001,54' })).bounds,
        [170, 51, 180, 54]);
    assert.deepEqual(parseChartMetadata(gdalInfo({ bounds: '-180.0001,51,-172,54' })).bounds,
        [-180, 51, -172, 54]);
});

for (const sheet of [
    {
        id: 'ifr-enroute-low-l13', kind: 'ifr-low', north: 49.2795,
        extent: ['-2300000', '1600000', '-300000', '400000'],
        sample: ['-112.35', '49.15']
    },
    {
        id: 'ifr-enroute-high-h01', kind: 'ifr-high', north: 50.04,
        extent: ['-2900000', '1700000', '-300000', '400000'],
        sample: ['-117.81', '49.6']
    }
]) test(`real GDAL build publishes the curved ${sheet.id} edge and actual stored zooms`, async t => {
    // Receipt/parser unit tests need no native tools. Exercise the real pipeline
    // too whenever the chart-building GDAL installation is available.
    try {
        await execFileAsync('gdal_create', ['--version']);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        t.skip('GDAL is not installed');
        return;
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-chart-metadata-'));
    try {
        const chartRoot = path.join(root, 'charts');
        const cycle = path.join(chartRoot, '2026-09-03');
        const cache = path.join(root, 'mbtiles', '2026-09-03');
        await fs.mkdir(cycle, { recursive: true });
        const source = path.join(cycle, `${sheet.id}.tif`);
        const archive = path.join(cache, `${sheet.id}.mbtiles`);
        await execFileAsync('gdal_create', [
            '-of', 'GTiff', '-outsize', '512', '256', '-bands', '3', '-burn', '255',
            '-a_srs', chartCutlineForFilename(source).srs,
            '-a_ullr', ...sheet.extent, source
        ]);
        await tileMbtilesFromTiff(source);
        await writeChartManifests(chartRoot);
        const actual = await readChartMetadata(archive);
        const manifest = JSON.parse(await fs.readFile(
            path.join(cache, 'chart-manifest.json'), 'utf8'
        ));
        const chart = manifest.charts[0];
        assert.equal(chart.kind, sheet.kind);
        assert.deepEqual(chart.bounds, actual.bounds);
        assert.equal(chart.minZoom, actual.minZoom);
        assert.equal(chart.maxZoom, actual.maxZoom);
        assert.notEqual(chart.maxZoom, 12);
        assert.ok(chart.bounds[3] > sheet.north);
        // These opaque pixels fall above a cutline joined in geographic coordinates.
        const { stdout } = await execFileAsync('gdallocationinfo', [
            '-wgs84', '-b', '4', '-valonly', archive, ...sheet.sample
        ]);
        assert.equal(Number(stdout.trim()), 255);
        await buildChartPackages(root);
        const delivery = path.join(cycle, 'mbtiles');
        const packages = JSON.parse(await fs.readFile(path.join(delivery, 'manifest.json'), 'utf8'));
        assert.equal(packages.schemaVersion, 2);
        assert.ok(packages.archives.length > 0);
        assert.ok(packages.archives.every(archive => archive.kind === sheet.kind));
        assert.deepEqual((await fs.readdir(delivery)).sort(),
            ['manifest.json', ...packages.archives.map(archive => archive.file)].sort());
        assert.equal(await fs.stat(archive).then(stat => stat.size), chart.byteLength);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});
