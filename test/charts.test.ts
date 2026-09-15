import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { discoverCharts } from '../lib/chart-discovery.ts';
import {
    chartCutlineForFilename,
    writeChartBuildReceipt,
    writeChartManifests
} from '../lib/chart-tiler.ts';

const CURRENT_CHART_RASTERS = [
    'vfr-sectional-las_vegas.tif',
    'vfr-sectional-los_angeles.tif',
    'vfr-sectional-san_francisco.tif',
    'vfr-terminal-las_vegas.tif',
    'vfr-terminal-las_vegas-flyway.tif',
    'vfr-terminal-los_angeles.tif',
    'vfr-terminal-los_angeles-flyway.tif',
    'vfr-terminal-san_diego.tif',
    'vfr-terminal-san_diego-flyway.tif',
    'vfr-terminal-san_francisco.tif',
    'vfr-terminal-san_francisco-flyway.tif',
    'ifr-enroute-low-l02.tif',
    'ifr-enroute-low-l03.tif',
    'ifr-enroute-low-l04.tif'
] as const;

test('every current VFR and IFR raster has a closed geographic cutline', () => {
    for (const filename of CURRENT_CHART_RASTERS) {
        const cutline = chartCutlineForFilename(filename);
        assert.match(cutline ?? '', /^POLYGON \(\(.+\)\)$/);
        const coordinates = cutline?.slice('POLYGON (('.length, -2).split(', ');
        assert.equal(coordinates?.[0], coordinates?.at(-1), filename);
    }
});

test('cutline lookup accepts an absolute path and rejects unreviewed charts', () => {
    assert.equal(
        chartCutlineForFilename('/tmp/VFR-TERMINAL-SAN_FRANCISCO.TIF'),
        chartCutlineForFilename('vfr-terminal-san_francisco.tif')
    );
    assert.equal(chartCutlineForFilename('vfr-sectional-seattle.tif'), undefined);
});

test('writes publisher-owned chart identities and cutline bounds atomically', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-chart-manifest-'));
    const cycle = '2026-09-03';
    const cycleDirectory = path.join(root, cycle);
    const tiff = 'ifr-enroute-low-l03.tif';
    const file = 'ifr-enroute-low-l03.mbtiles';
    const sourceBytes = Buffer.from('stable source raster');
    const bytes = Buffer.from('stable chart artifact');
    try {
        await fs.mkdir(cycleDirectory);
        await fs.writeFile(path.join(cycleDirectory, tiff), sourceBytes);
        await fs.writeFile(path.join(cycleDirectory, file), bytes);
        await assert.rejects(writeChartManifests(root), /stale or unverifiable/);
        await writeChartBuildReceipt(
            path.join(cycleDirectory, tiff),
            path.join(cycleDirectory, file)
        );
        await writeChartManifests(root);

        const manifest = JSON.parse(
            await fs.readFile(path.join(cycleDirectory, 'chart-manifest.json'), 'utf8')
        );
        assert.equal(manifest.schemaVersion, 1);
        assert.equal(manifest.effectiveDate, cycle);
        assert.equal(manifest.charts.length, 1);
        assert.deepEqual(manifest.charts[0], {
            id: 'ifr-enroute-low-l03',
            title: 'IFR Low · L03',
            kind: 'ifr-low',
            minZoom: 7,
            maxZoom: 12,
            file,
            bounds: [-123.5471038, 32.7470033, -117.371356, 39.7247453],
            byteLength: bytes.byteLength,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            sourceByteLength: sourceBytes.byteLength,
            sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'),
            tilerVersion: 1,
            buildConfigurationSha256: manifest.charts[0].buildConfigurationSha256,
            cutlineProvenance:
                'N129BZ/chartmaker@1d71db443916b8052dde41d612c3311bac25a5ae'
        });
        assert.match(manifest.charts[0].buildConfigurationSha256, /^[a-f0-9]{64}$/);

        await fs.writeFile(path.join(cycleDirectory, tiff), 'changed source raster');
        await assert.rejects(writeChartManifests(root), /stale or unverifiable/);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('chart manifest reconciliation removes a stale manifest with no chart files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-chart-empty-manifest-'));
    const cycleDirectory = path.join(root, '2026-09-03');
    const manifestPath = path.join(cycleDirectory, 'chart-manifest.json');
    try {
        await fs.mkdir(cycleDirectory);
        await fs.writeFile(manifestPath, '{"charts":[{"file":"missing.mbtiles"}]}\n');
        await writeChartManifests(root);
        await assert.rejects(fs.access(manifestPath), /ENOENT/);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('chart discovery reads the latest real FAA listings without inventing files', async () => {
    const pages: Record<string, string> = {
        'https://aeronav.faa.gov/upload_313-d/supplements/':
            '<a href="CS_SW_20260903.pdf">CS_SW_20260903.pdf</a>',
        'https://aeronav.faa.gov/upload_313-d/terminal/': [
            '<a href="2026-08-06/">2026-08-06</a>',
            '<a href="2026-09-03/">2026-09-03</a>',
            '<a href="2026-10-01/">2026-10-01</a>'
        ].join(''),
        'https://aeronav.faa.gov/upload_313-d/terminal/2026-09-03/':
            ['SW1', 'SW2', 'SW3', 'SW4']
                .map(region => `<a href="${region}.pdf">${region}.pdf</a>`).join(''),
        'https://aeronav.faa.gov/enroute/': [
            '<a href="08-06-2026/">08-06-2026</a>',
            '<a href="09-03-2026/">09-03-2026</a>'
        ].join(''),
        'https://aeronav.faa.gov/enroute/09-03-2026/':
            ['L02', 'L03', 'L04']
                .map(region => `<a href="ENR_${region}.zip">ENR_${region}.zip</a>`).join(''),
        'https://aeronav.faa.gov/visual/':
            '<a href="09-03-2026/">09-03-2026</a>',
        'https://aeronav.faa.gov/visual/09-03-2026/sectional-files/':
            ['San_Francisco', 'Los_Angeles', 'Las_Vegas']
                .map(region => `<a href="${region}.zip">${region}.zip</a>`).join(''),
        'https://aeronav.faa.gov/visual/09-03-2026/tac-files/':
            ['San_Francisco', 'Los_Angeles', 'San_Diego', 'Las_Vegas']
                .map(region => `<a href="${region}_TAC.zip">${region}_TAC.zip</a>`).join('')
    };
    const requested: string[] = [];
    const fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        requested.push(url);
        return pages[url] === undefined
            ? new Response(null, { status: 404 })
            : new Response(pages[url]);
    }) as typeof globalThis.fetch;

    const groups = await discoverCharts({ fetch, today: '2026-09-14' });
    const sectional = groups.find(group => group.prefix === 'vfr-sectional');
    const terminal = groups.find(group => group.prefix === 'vfr-terminal');
    assert.deepEqual(Object.keys(sectional?.files ?? {}), [
        'San_Francisco', 'Los_Angeles', 'Las_Vegas'
    ]);
    assert.equal(sectional?.files.San_Diego, undefined);
    assert.ok(terminal?.files.San_Diego.current?.url.endsWith('/San_Diego_TAC.zip'));
    assert.ok(!requested.some(url => url.includes('2026-08-06/')));
});
