import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CHART_DEFINITIONS } from '../lib/chart-definitions.ts';
import { configuredRasterFilenames, discoverCharts } from '../lib/chart-discovery.ts';
import type { ChartMetadata } from '../lib/chart-metadata.ts';
import {
    chartCutlineForFilename,
    tileMbtilesFromTiff,
    writeChartBuildReceipt,
    writeChartManifests,
    type ChartBuildReceipt
} from '../lib/chart-tiler.ts';

const IFR_LOW_REGIONS = Array.from(
    { length: 36 },
    (_, index) => `L${String(index + 1).padStart(2, '0')}`
);
const IFR_HIGH_REGIONS = Array.from(
    { length: 12 },
    (_, index) => `H${String(index + 1).padStart(2, '0')}`
);
const SECTIONAL_REGIONS = [
    'Albuquerque', 'Anchorage', 'Atlanta', 'Bethel', 'Billings', 'Brownsville',
    'Cape_Lisburne', 'Charlotte', 'Cheyenne', 'Chicago', 'Cincinnati', 'Cold_Bay',
    'Dallas-Ft_Worth', 'Dawson', 'Denver', 'Detroit', 'Dutch_Harbor', 'El_Paso',
    'Fairbanks', 'Great_Falls', 'Green_Bay', 'Halifax', 'Hawaiian_Islands', 'Houston',
    'Jacksonville', 'Juneau', 'Kansas_City', 'Ketchikan', 'Klamath_Falls', 'Kodiak',
    'Lake_Huron', 'Las_Vegas', 'Los_Angeles', 'McGrath', 'Memphis', 'Miami', 'Montreal',
    'New_Orleans', 'New_York', 'Nome', 'Omaha', 'Phoenix', 'Point_Barrow',
    'Salt_Lake_City', 'San_Antonio', 'San_Francisco', 'Seattle', 'Seward', 'St_Louis',
    'Twin_Cities', 'Washington', 'Western_Aleutian_Islands', 'Wichita'
] as const;
// Observed TIFF members of all FAA TAC ZIPs, including ancillary graphics that
// are not georeferenced chart sheets. Keep this independent of discovery config.
const TERMINAL_CATALOG: {
    effectiveDate: string;
    source: string;
    archives: Array<{ region: string; tiffs: string[] }>;
} = JSON.parse(await fs.readFile(
    new URL('./fixtures/vfr-terminal-2026-09-03.json', import.meta.url), 'utf8'
));
const TERMINAL_REGIONS = TERMINAL_CATALOG.archives.map(archive => archive.region);
const SUPPLEMENT_REGIONS = ['AK', 'EC', 'NC', 'NE', 'NW', 'PAC', 'SC', 'SE', 'SW'] as const;
const PROCEDURE_REGIONS = [
    'AK',
    'EC1', 'EC2', 'EC3',
    'NC1', 'NC2', 'NC3',
    'NE1', 'NE2', 'NE3', 'NE4',
    'NW1',
    'SC1', 'SC2', 'SC3', 'SC4', 'SC5',
    'SE1', 'SE2', 'SE3', 'SE4',
    'SW1', 'SW2', 'SW3', 'SW4'
] as const;

// The dummy archive bytes in receipt/migration tests are not SQLite databases.
const readFixtureMetadata = async (): Promise<ChartMetadata> => ({
    bounds: [-122.1471747, 43.9849979, -102.5427588, 49.2822198],
    minZoom: 4,
    maxZoom: 11
});

test('every current VFR and IFR raster has a closed cutline', () => {
    const filenames = configuredRasterFilenames();
    assert.equal(filenames.length, 162);
    assert.equal(Object.values(CHART_DEFINITIONS).filter(chart => chart.kind === 'ifr-low').length, 37);
    assert.equal(Object.values(CHART_DEFINITIONS).filter(chart => chart.kind === 'ifr-high').length, 12);
    assert.equal(Object.values(CHART_DEFINITIONS).filter(chart => chart.kind === 'vfr-terminal').length, 34);
    assert.equal(Object.values(CHART_DEFINITIONS).filter(chart => chart.kind === 'vfr-flyway').length, 21);
    assert.equal(new Set(filenames).size, filenames.length);
    assert.deepEqual(Object.keys(CHART_DEFINITIONS).sort(), filenames);
    assert.equal(
        CHART_DEFINITIONS['vfr-sectional-mcgrath.tif'].title,
        'Sectional · McGrath'
    );
    assert.equal(
        CHART_DEFINITIONS[
            'vfr-sectional-western_aleutian_islands-east-eastern_hemisphere.tif'
        ].title,
        'Sectional · Western Aleutian Islands East (eastern hemisphere)'
    );
    for (const filename of filenames) {
        const cutline = chartCutlineForFilename(filename);
        assert.match(cutline?.wkt ?? '', /^POLYGON \(\(.+\)\)$/);
        assert.equal(
            cutline?.srs === 'EPSG:4326',
            !filename.startsWith('ifr-enroute-'),
            filename
        );
        const coordinates = cutline?.wkt.slice('POLYGON (('.length, -2).split(', ');
        assert.equal(coordinates?.[0], coordinates?.at(-1), filename);
    }
});

test('terminal and Flyway cutlines retain main airports and exclude displaced insets', () => {
    function contains(filename: string, [x, y]: [number, number]): boolean {
        const ring = CHART_DEFINITIONS[filename].coordinates;
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i];
            const [xj, yj] = ring[j];
            if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
                inside = !inside;
            }
        }
        return inside;
    }
    for (const filename of ['vfr-terminal-miami.tif', 'vfr-terminal-miami-flyway.tif']) {
        assert.equal(contains(filename, [-80.2906, 25.7932]), true, `${filename}: Miami Intl`);
        // Where the displaced Florida Keys inset would be drawn on the main map.
        assert.equal(contains(filename, [-79.6774, 25.2514]), false, `${filename}: Keys inset`);
    }
    const puertoRico = 'vfr-terminal-puerto_rico-vi.tif';
    assert.equal(contains(puertoRico, [-66.0018, 18.4394]), true, 'San Juan');
    assert.equal(contains(puertoRico, [-64.9734, 18.3373]), true, 'St Thomas');
    assert.equal(contains(puertoRico, [-64.7986, 17.7019]), true, 'St Croix');
    assert.equal(contains(puertoRico, [-65.5411, 18.6111]), false, 'upper inset strip');
    assert.equal(contains(puertoRico, [-67.4081, 18.0998]), false, 'Mona inset');
});

test('cutline lookup accepts an absolute path and rejects unreviewed charts', () => {
    assert.deepEqual(
        chartCutlineForFilename('/tmp/VFR-TERMINAL-SAN_FRANCISCO.TIF'),
        chartCutlineForFilename('vfr-terminal-san_francisco.tif')
    );
    assert.equal(chartCutlineForFilename('vfr-sectional-not_a_chart.tif'), undefined);
});

test('IFR cutlines use the FAA raster projection', () => {
    const cutline = chartCutlineForFilename('ifr-enroute-low-l12.tif');
    assert.match(cutline?.srs ?? '', /^\+proj=lcc /);
    const first = cutline?.wkt
        .slice('POLYGON (('.length, -2)
        .split(', ')[0]
        .split(' ')
        .map(Number);
    assert.ok(first);
    assert.ok(Math.abs(first[0] - -919_698.469335528) < 1e-6);
    assert.ok(Math.abs(first[1] - 744_513.963466994) < 1e-6);
});

test('a chart retry removes stale GDAL temporary files before using its cache', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-chart-retry-'));
    const basePath = path.join(root, 'ifr-enroute-low-l03');
    const tifPath = `${basePath}.tif`;
    const mbtilesPath = `${basePath}.mbtiles`;
    const lockPath = `${basePath}.build.lock`;
    const temporaryPaths = [
        `${basePath}-rgb.vrt`,
        `${basePath}-alpha.vrt`,
        `${basePath}.next.mbtiles`,
        `${basePath}.next.mbtiles-journal`,
        `${basePath}.next.partial_tiles.db`
    ];
    const staleWorkDirectory = `${basePath}.work-abandoned`;
    try {
        await fs.writeFile(tifPath, 'source raster');
        await fs.writeFile(mbtilesPath, 'finished mbtiles');
        await writeChartBuildReceipt(tifPath, mbtilesPath);
        await Promise.all(temporaryPaths.map(filePath => fs.writeFile(filePath, 'stale')));
        await fs.mkdir(staleWorkDirectory);
        await fs.writeFile(path.join(staleWorkDirectory, 'partial_tiles.db'), 'stale');
        await fs.writeFile(lockPath, JSON.stringify({
            pid: 2_147_483_647,
            token: 'stale-test'
        }));

        await tileMbtilesFromTiff(tifPath);

        const relocated = path.join(root, 'mbtiles', path.basename(mbtilesPath));
        assert.equal(await fs.readFile(relocated, 'utf8'), 'finished mbtiles');
        await fs.access(`${relocated}.build.json`);
        await assert.rejects(fs.access(mbtilesPath), /ENOENT/);
        await assert.rejects(fs.access(`${mbtilesPath}.build.json`), /ENOENT/);
        // A subsequent run reuses the relocated cache without needing GDAL.
        await tileMbtilesFromTiff(tifPath);

        await Promise.all(temporaryPaths.map(filePath =>
            assert.rejects(fs.access(filePath), /ENOENT/)
        ));
        await assert.rejects(fs.access(staleWorkDirectory), /ENOENT/);
        await assert.rejects(fs.access(lockPath), /ENOENT/);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('a chart build lock rejects a concurrent render of the same TIFF', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-chart-lock-'));
    const basePath = path.join(root, 'ifr-enroute-low-l03');
    const tifPath = `${basePath}.tif`;
    const lockPath = `${basePath}.build.lock`;
    try {
        await fs.writeFile(tifPath, 'source raster');
        await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, token: 'active-test' }));

        await assert.rejects(
            tileMbtilesFromTiff(tifPath),
            new RegExp(`Chart build already in progress.*pid ${process.pid}`)
        );
        assert.equal(JSON.parse(await fs.readFile(lockPath, 'utf8')).token, 'active-test');
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('relocation refuses conflicting files before moving either artifact', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-chart-layout-conflict-'));
    const tifPath = path.join(root, 'ifr-enroute-low-l03.tif');
    const legacyPath = tifPath.replace('.tif', '.mbtiles');
    const outputPath = path.join(root, 'mbtiles', path.basename(legacyPath));
    try {
        await fs.mkdir(path.dirname(outputPath));
        await fs.writeFile(tifPath, 'source');
        await fs.writeFile(legacyPath, 'legacy archive');
        await writeChartBuildReceipt(tifPath, legacyPath);
        // Even a receipt-only destination conflict must not move the old archive.
        await fs.writeFile(`${outputPath}.build.json`, 'existing receipt');
        await assert.rejects(tileMbtilesFromTiff(tifPath), /Chart layout conflict/);
        assert.equal(await fs.readFile(legacyPath, 'utf8'), 'legacy archive');
        assert.equal(await fs.readFile(`${outputPath}.build.json`, 'utf8'), 'existing receipt');
        await fs.access(`${legacyPath}.build.json`);
        await assert.rejects(fs.access(outputPath), /ENOENT/);
        await assert.rejects(fs.access(tifPath.replace('.tif', '.build.lock')), /ENOENT/);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('main-branch receipts retain VFR caches and require the IFR cutline rebuild', async t => {
    // These receipts were generated by the unmodified tiler at 2a9ce57, before
    // the cache layout and Lambert cutline changes, rather than by this version.
    const fixture: { source: string; output: string; receipts: Record<string, ChartBuildReceipt> } =
        JSON.parse(await fs.readFile(new URL('./fixtures/chart-receipts-2a9ce57.json', import.meta.url), 'utf8'));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-chart-main-upgrade-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    for (const [filename, receipt] of Object.entries(fixture.receipts)) {
        const charts = path.join(root, filename, 'charts');
        const cycle = path.join(charts, '2026-09-03');
        const cache = path.join(root, filename, 'mbtiles', '2026-09-03');
        const source = path.join(cycle, filename);
        const legacy = source.replace(/\.tif$/, '.mbtiles');
        const relocated = path.join(cache, path.basename(legacy));
        await fs.mkdir(cycle, { recursive: true });
        await fs.writeFile(source, fixture.source);
        await fs.writeFile(legacy, fixture.output);
        await fs.writeFile(`${legacy}.build.json`, JSON.stringify(receipt));
        if (filename.startsWith('ifr-')) {
            await assert.rejects(writeChartManifests(charts, readFixtureMetadata), /stale or unverifiable/);
            await assert.rejects(fs.access(path.join(cache, 'chart-manifest.json')), /ENOENT/);
            assert.equal(await fs.readFile(relocated, 'utf8'), fixture.output);
            assert.deepEqual(JSON.parse(await fs.readFile(`${relocated}.build.json`, 'utf8')), receipt);
            // Simulate the renderer replacing the relocated stale sheet. A retry
            // must recognize its new receipt and finish the interrupted migration.
            await fs.writeFile(relocated, 'rebuilt with Lambert cutline');
            const rebuilt = await writeChartBuildReceipt(source, relocated);
            assert.notEqual(rebuilt.configurationSha256, receipt.configurationSha256);
        }
        await writeChartManifests(charts, readFixtureMetadata);
        const manifest = JSON.parse(await fs.readFile(path.join(cache, 'chart-manifest.json'), 'utf8'));
        assert.equal(manifest.charts.length, 1);
        if (filename.startsWith('vfr-')) {
            assert.equal(manifest.charts[0].sha256, receipt.output.sha256);
            assert.equal(manifest.charts[0].buildConfigurationSha256, receipt.configurationSha256);
        }
        await assert.rejects(fs.access(legacy), /ENOENT/);
    }
});

test('publishes inspected metadata and verified identities, preserving the manifest on failure', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-chart-manifest-'));
    const cycle = '2026-09-03';
    const cycleDirectory = path.join(root, cycle);
    const mbtilesDirectory = path.join(cycleDirectory, 'mbtiles');
    const tiff = 'ifr-enroute-low-l13.tif';
    const file = 'ifr-enroute-low-l13.mbtiles';
    const sourceBytes = Buffer.from('stable source raster');
    const bytes = Buffer.from('stable chart artifact');
    try {
        await fs.mkdir(mbtilesDirectory, { recursive: true });
        await fs.writeFile(path.join(cycleDirectory, tiff), sourceBytes);
        await fs.writeFile(path.join(mbtilesDirectory, file), bytes);
        await assert.rejects(writeChartManifests(root), /stale or unverifiable/);
        const receipt = await writeChartBuildReceipt(
            path.join(cycleDirectory, tiff),
            path.join(mbtilesDirectory, file)
        );
        const inspected: string[] = [];
        await writeChartManifests(root, async filePath => {
            inspected.push(filePath);
            return readFixtureMetadata();
        });
        assert.deepEqual(inspected, [path.join(mbtilesDirectory, file)]);

        const manifest = JSON.parse(
            await fs.readFile(path.join(mbtilesDirectory, 'chart-manifest.json'), 'utf8')
        );
        assert.equal(manifest.schemaVersion, 1);
        assert.equal(manifest.effectiveDate, cycle);
        assert.equal(manifest.charts.length, 1);
        assert.deepEqual(manifest.charts[0], {
            id: 'ifr-enroute-low-l13',
            title: 'IFR Low · L13',
            kind: 'ifr-low',
            minZoom: 4,
            maxZoom: 11,
            file,
            bounds: [-122.1471747, 43.9849979, -102.5427588, 49.2822198],
            byteLength: bytes.byteLength,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            sourceByteLength: sourceBytes.byteLength,
            sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'),
            tilerVersion: 1,
            buildConfigurationSha256: receipt.configurationSha256,
            cutlineProvenance:
                'N129BZ/chartmaker@1d71db443916b8052dde41d612c3311bac25a5ae' +
                '+local-lambert-neatline@faa-raster-2026-09-03'
        });
        assert.match(manifest.charts[0].buildConfigurationSha256, /^[a-f0-9]{64}$/);

        // A metadata failure must not replace the previous published manifest.
        await assert.rejects(writeChartManifests(root, async () => {
            throw new Error('Invalid MBTiles zoom level');
        }), /Invalid MBTiles zoom/);
        assert.deepEqual(JSON.parse(await fs.readFile(
            path.join(mbtilesDirectory, 'chart-manifest.json'), 'utf8'
        )), manifest);

        await fs.writeFile(path.join(cycleDirectory, tiff), 'changed source raster');
        await assert.rejects(writeChartManifests(root), /stale or unverifiable/);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('chart manifest reconciliation removes a stale manifest with no chart files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-chart-empty-manifest-'));
    const cycleDirectory = path.join(root, '2026-09-03');
    const manifestPath = path.join(cycleDirectory, 'mbtiles', 'chart-manifest.json');
    const legacyManifestPath = path.join(cycleDirectory, 'chart-manifest.json');
    try {
        await fs.mkdir(path.dirname(manifestPath), { recursive: true });
        await fs.writeFile(manifestPath, '{"charts":[{"file":"missing.mbtiles"}]}\n');
        await fs.writeFile(legacyManifestPath, '{}\n');
        await writeChartManifests(root);
        await assert.rejects(fs.access(manifestPath), /ENOENT/);
        await assert.rejects(fs.access(legacyManifestPath), /ENOENT/);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('chart discovery covers all selected PDF volumes and rasters in representative FAA listings', async () => {
    const pages: Record<string, string> = {
        'https://aeronav.faa.gov/upload_313-d/supplements/':
            SUPPLEMENT_REGIONS.flatMap(region => ['20260709', '20260903', '20261029'].map(date =>
                `<a href="CS_${region}_${date}.pdf">CS_${region}_${date}.pdf</a>`
            )).join(''),
        'https://aeronav.faa.gov/upload_313-d/terminal/': [
            '<a href="2026-08-06/">2026-08-06</a>',
            '<a href="2026-09-03/">2026-09-03</a>',
            '<a href="2026-10-01/">2026-10-01</a>'
        ].join(''),
        'https://aeronav.faa.gov/upload_313-d/terminal/2026-09-03/':
            PROCEDURE_REGIONS
                .map(region => `<a href="${region}.pdf">${region}.pdf</a>`).join(''),
        'https://aeronav.faa.gov/enroute/': [
            '<a href="08-06-2026/">08-06-2026</a>',
            '<a href="09-03-2026/">09-03-2026</a>'
        ].join(''),
        'https://aeronav.faa.gov/enroute/09-03-2026/':
            [...IFR_LOW_REGIONS, ...IFR_HIGH_REGIONS]
                .map(region => `<a href="ENR_${region}.zip">ENR_${region}.zip</a>`).join(''),
        'https://aeronav.faa.gov/visual/':
            '<a href="09-03-2026/">09-03-2026</a>',
        'https://aeronav.faa.gov/visual/09-03-2026/sectional-files/':
            SECTIONAL_REGIONS
                .map(region => `<a href="${region}.zip">${region}.zip</a>`).join(''),
        'https://aeronav.faa.gov/visual/09-03-2026/tac-files/':
            TERMINAL_REGIONS
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
    const supplements = groups.find(group => group.prefix === 'cs');
    const procedures = groups.find(group => group.prefix === 'tpp');
    const low = groups.find(group => group.prefix === 'ifr-enroute-low');
    const high = groups.find(group => group.prefix === 'ifr-enroute-high');
    const sectional = groups.find(group => group.prefix === 'vfr-sectional');
    const terminal = groups.find(group => group.prefix === 'vfr-terminal');
    assert.deepEqual(Object.keys(supplements.files), SUPPLEMENT_REGIONS);
    assert.deepEqual(Object.keys(procedures.files), PROCEDURE_REGIONS);
    for (const region of SUPPLEMENT_REGIONS) {
        assert.deepEqual(supplements.files[region].current, {
            url: `https://aeronav.faa.gov/upload_313-d/supplements/CS_${region}_20260903.pdf`,
            date: '2026-09-03'
        });
    }
    for (const region of PROCEDURE_REGIONS) {
        assert.deepEqual(procedures.files[region].current, {
            url: `https://aeronav.faa.gov/upload_313-d/terminal/2026-09-03/${region}.pdf`,
            date: '2026-09-03'
        });
    }
    for (const [altitude, title, regions, group] of [
        ['low', 'Low', IFR_LOW_REGIONS, low],
        ['high', 'High', IFR_HIGH_REGIONS, high]
    ] as const) {
        assert.deepEqual(Object.keys(group?.files ?? {}), regions);
        for (const region of regions) {
            const candidate = group?.files[region].current;
            assert.equal(candidate?.url, `https://aeronav.faa.gov/enroute/09-03-2026/ENR_${region}.zip`);
            assert.equal(candidate?.date, '2026-09-03');
            // Check the split L06 archive explicitly below.
            if (region === 'L06') continue;
            const filename = `ifr-enroute-${altitude}-${region.toLowerCase()}.tif`;
            assert.deepEqual(candidate?.extractions, [{ sourceName: `ENR_${region}.tif`, filename }]);
            assert.equal(CHART_DEFINITIONS[filename].kind, `ifr-${altitude}`);
            assert.equal(CHART_DEFINITIONS[filename].title, `IFR ${title} · ${region}`);
        }
    }
    assert.deepEqual(Object.keys(sectional?.files ?? {}), SECTIONAL_REGIONS);
    assert.deepEqual(Object.keys(terminal?.files ?? {}), TERMINAL_REGIONS);
    assert.ok(Object.values(sectional?.files ?? {}).every(listing => listing.current));
    assert.ok(Object.values(terminal?.files ?? {}).every(listing => listing.current));
    assert.deepEqual(low?.files.L06.current?.extractions, [
        { sourceName: 'ENR_L06N.tif', filename: 'ifr-enroute-low-l06n.tif' },
        { sourceName: 'ENR_L06S.tif', filename: 'ifr-enroute-low-l06s.tif' }
    ]);
    assert.deepEqual(sectional?.files.Hawaiian_Islands.current?.extractions, [
        {
            sourceName: 'Hawaiian_Islands_SEC.tif',
            filename: 'vfr-sectional-hawaiian_islands.tif'
        },
        {
            sourceName: 'Honolulu_Inset_SEC.tif',
            filename: 'vfr-sectional-honolulu_inset.tif'
        },
        {
            sourceName: 'Mariana_Islands_Inset_SEC.tif',
            filename: 'vfr-sectional-mariana_islands_inset.tif'
        },
        {
            sourceName: 'Samoan_Islands_Inset_SEC.tif',
            filename: 'vfr-sectional-samoan_islands_inset.tif'
        }
    ]);
    assert.deepEqual(sectional?.files.Western_Aleutian_Islands.current?.extractions, [
        {
            sourceName: 'Western_Aleutian_Islands_East_SEC.tif',
            filename: 'vfr-sectional-western_aleutian_islands-east-eastern_hemisphere.tif'
        },
        {
            sourceName: 'Western_Aleutian_Islands_East_SEC.tif',
            filename: 'vfr-sectional-western_aleutian_islands-east-western_hemisphere.tif'
        },
        {
            sourceName: 'Western_Aleutian_Islands_West_SEC.tif',
            filename: 'vfr-sectional-western_aleutian_islands-west.tif'
        }
    ]);
    assert.deepEqual(sectional?.files.Albuquerque.current?.extractions, [
        {
            sourceName: 'Albuquerque_SEC.tif',
            filename: 'vfr-sectional-albuquerque.tif'
        }
    ]);
    assert.equal(sectional?.files.San_Diego, undefined);
    assert.deepEqual(terminal?.files.San_Diego.current?.extractions, [
        {
            sourceName: 'San_Diego_TAC.tif',
            filename: 'vfr-terminal-san_diego.tif'
        },
        {
            sourceName: 'San_Diego_FLY.tif',
            filename: 'vfr-terminal-san_diego-flyway.tif'
        }
    ]);
    for (const { region, tiffs } of TERMINAL_CATALOG.archives) {
        const candidate = terminal.files[region].current;
        assert.equal(candidate.date, TERMINAL_CATALOG.effectiveDate);
        assert.equal(candidate.url, `${TERMINAL_CATALOG.source}${region}_TAC.zip`);
        const expected = tiffs.filter(name => / (TAC|FLY)\.tif$/.test(name)).map(name => {
            const [, sheet, kind] = name.match(/^(.+) (TAC|FLY)\.tif$/)!;
            const slug = sheet.replaceAll(' ', '_').toLowerCase();
            return {
                sourceName: name.replaceAll(' ', '_'),
                filename: `vfr-terminal-${slug}${kind === 'FLY' ? '-flyway' : ''}.tif`
            };
        });
        assert.deepEqual(
            [...candidate.extractions].sort((a, b) => a.filename.localeCompare(b.filename)),
            [...expected].sort((a, b) => a.filename.localeCompare(b.filename)),
            region
        );
        for (const extraction of expected) {
            const definition = CHART_DEFINITIONS[extraction.filename];
            const flyway = extraction.filename.endsWith('-flyway.tif');
            assert.equal(definition.kind, flyway ? 'vfr-flyway' : 'vfr-terminal');
            assert.ok(definition.title.startsWith(flyway ? 'Flyway · ' : 'Terminal · '));
        }
    }
    assert.ok(!requested.some(url => url.includes('2026-08-06/')));
    assert.ok(!requested.some(url => url.includes('2026-10-01/')));

    pages['https://aeronav.faa.gov/enroute/09-03-2026/'] = [...IFR_LOW_REGIONS, ...IFR_HIGH_REGIONS]
        .filter(region => region !== 'L36' && region !== 'H12')
        .map(region => `<a href="ENR_${region}.zip">ENR_${region}.zip</a>`).join('');
    pages['https://aeronav.faa.gov/visual/09-03-2026/sectional-files/'] = SECTIONAL_REGIONS
        .filter(region => region !== 'Seattle')
        .map(region => `<a href="${region}.zip">${region}.zip</a>`).join('');
    pages['https://aeronav.faa.gov/visual/09-03-2026/tac-files/'] = TERMINAL_REGIONS
        .filter(region => region !== 'Tampa-Orlando')
        .map(region => `<a href="${region}_TAC.zip">${region}_TAC.zip</a>`).join('');
    await assert.rejects(
        discoverCharts({ fetch, today: '2026-09-14' }),
        /ifr-enroute-low\/L36.*ifr-enroute-high\/H12.*vfr-sectional\/Seattle.*vfr-terminal\/Tampa-Orlando/
    );
});
