import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { promisify } from 'node:util';
import {
    buildNasrData,
    discoverCurrentNasrCycle,
    discoverNasrGroupUrls,
    downloadNasrFile,
    pruneNasrCycles
} from '../download-nasr.ts';
import { parseCsvRecords, parseCsvRows } from '../lib/csv.ts';
import { buildNasrProducts, type NasrInput } from '../lib/nasr.ts';
import { assertSafeZipEntry } from '../lib/zip.ts';

function csv(headers: string[], rows: Array<Array<string | number>>): string {
    const quote = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;
    return [headers, ...rows].map(row => row.map(quote).join(',')).join('\r\n') + '\r\n';
}

test('CSV parser handles quoted commas, escaped quotes, and embedded newlines', () => {
    const source = '"one","two"\r\n"a","comma, quote ""and"" newline\nkept"\r\n';
    assert.deepEqual(parseCsvRows(source), [
        ['one', 'two'],
        ['a', 'comma, quote "and" newline\nkept']
    ]);
    assert.deepEqual(parseCsvRecords(source), [
        { one: 'a', two: 'comma, quote "and" newline\nkept' }
    ]);
});

test('NASR discovery selects the latest effective cycle and all required groups', () => {
    const index = `
        <a href="2026-08-06/">Archive</a>
        <a href="2026-09-03/">Current</a>
        <a href="2026-10-01/">Preview</a>`;
    assert.deepEqual(
        discoverCurrentNasrCycle(index, 'https://www.faa.gov/NASR_Subscription/', '2026-09-12'),
        {
            cycle: '2026-09-03',
            url: 'https://www.faa.gov/NASR_Subscription/2026-09-03/'
        }
    );

    const cycle = ['APT', 'FRQ', 'FIX', 'NAV', 'AWY', 'PFR', 'DP', 'STAR']
        .map(group => `<a href="https://nfdc.faa.gov/data_2026_${group}_CSV.zip">${group}</a>`)
        .join('');
    assert.deepEqual(
        discoverNasrGroupUrls(cycle, 'https://www.faa.gov/cycle/'),
        {
            APT: 'https://nfdc.faa.gov/data_2026_APT_CSV.zip',
            FRQ: 'https://nfdc.faa.gov/data_2026_FRQ_CSV.zip',
            FIX: 'https://nfdc.faa.gov/data_2026_FIX_CSV.zip',
            NAV: 'https://nfdc.faa.gov/data_2026_NAV_CSV.zip',
            AWY: 'https://nfdc.faa.gov/data_2026_AWY_CSV.zip',
            PFR: 'https://nfdc.faa.gov/data_2026_PFR_CSV.zip',
            DP: 'https://nfdc.faa.gov/data_2026_DP_CSV.zip',
            STAR: 'https://nfdc.faa.gov/data_2026_STAR_CSV.zip'
        }
    );
    assert.throws(
        () => discoverNasrGroupUrls(cycle.replace(/<a[^>]*>PFR<\/a>/, ''), 'https://www.faa.gov/cycle/'),
        /missing CSV groups: PFR/
    );
});

test('navigation builds reject invalid options before fetching or creating output', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-nav-options-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const output = path.join(root, 'output');
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        requests++;
        throw new Error('Unexpected network request');
    });
    const cases: [Partial<Parameters<typeof buildNasrData>[0]>, RegExp][] = [
        [{ cycle: '2026-09-03' }, /--cycle requires --source-dir/],
        [{ sourceDir: root }, /--cycle is required with --source-dir/],
        [{ sourceDir: root, cycle: '2026-02-30' }, /valid YYYY-MM-DD date/],
        [{ sourceDir: root, cycle: '2026-13-01' }, /valid YYYY-MM-DD date/],
        [{ sourceDir: root, cycle: 'bad-date' }, /valid YYYY-MM-DD date/],
        [{ sourceDir: ' ' }, /--source-dir must not be empty/],
        [{ routeHistorySource: ' ' }, /--route-history-source must not be empty/],
        [{ retainCycles: 0 }, /--retain-cycles must be a positive integer/],
        [{ output: ' ' }, /--output must not be empty/],
        [{ output: '' }, /--output must not be empty/]
    ];
    for (const [options, expected] of cases) {
        await assert.rejects(buildNasrData({ output, ...options }), expected);
    }
    assert.equal(requests, 0);
    assert.deepEqual(await fs.readdir(root), []);
});

test('navigation CLI rejects an online cycle override before starting a build', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-nav-cli-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await assert.rejects(promisify(execFile)(process.execPath, [
        '--import=tsx', 'download-nasr.ts', `--output=${path.join(root, 'output')}`, '--cycle=2026-09-03'
    ], { cwd: new URL('..', import.meta.url), timeout: 10_000 }), {
        code: 1,
        stderr: /--cycle requires --source-dir/
    });
    assert.deepEqual(await fs.readdir(root), []);
});

test('NASR retention removes only stale nested data from chart cycle directories', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-nasr-retention-'));
    try {
        for (const cycle of ['2026-07-09', '2026-08-06', '2026-09-03']) {
            await fs.mkdir(path.join(root, cycle, 'nav'), { recursive: true });
            await fs.mkdir(path.join(root, cycle, 'nasr'));
            await fs.writeFile(path.join(root, cycle, 'nav', 'manifest.json'), cycle);
            await fs.writeFile(path.join(root, cycle, 'nasr', 'APT_CSV.zip'), cycle);
        }
        await fs.writeFile(path.join(root, '2026-07-09', 'tpp-sw1.pdf'), '%PDF-test');

        await pruneNasrCycles(root, 2);

        await assert.rejects(fs.access(path.join(root, '2026-07-09', 'nav')), /ENOENT/);
        await assert.rejects(fs.access(path.join(root, '2026-07-09', 'nasr')), /ENOENT/);
        await fs.access(path.join(root, '2026-07-09', 'tpp-sw1.pdf'));
        await fs.access(path.join(root, '2026-08-06', 'nav', 'manifest.json'));
        await fs.access(path.join(root, '2026-09-03', 'nasr', 'APT_CSV.zip'));
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('NASR retention preserves an explicitly built older cycle', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-nasr-retention-preserve-'));
    try {
        for (const cycle of ['2026-07-09', '2026-08-06', '2026-09-03']) {
            await fs.mkdir(path.join(root, cycle, 'nav'), { recursive: true });
            await fs.mkdir(path.join(root, cycle, 'nasr'));
        }

        await pruneNasrCycles(root, 2, '2026-07-09');

        await fs.access(path.join(root, '2026-07-09', 'nav'));
        await assert.rejects(fs.access(path.join(root, '2026-08-06', 'nav')), /ENOENT/);
        await fs.access(path.join(root, '2026-09-03', 'nasr'));
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('ZIP entry validation rejects traversal and pattern matching', () => {
    assert.doesNotThrow(() => assertSafeZipEntry('APT_BASE.csv'));
    for (const entry of ['../APT_BASE.csv', '/APT_BASE.csv', 'APT*.csv', '-APT_BASE.csv']) {
        assert.throws(() => assertSafeZipEntry(entry), /ZIP entry|Unsafe ZIP/);
    }
});

test('NASR downloader replaces a corrupt cache and removes an invalid response', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-nasr-download-'));
    const destination = path.join(root, 'APT_CSV.zip');
    const originalFetch = globalThis.fetch;
    let requests = 0;
    try {
        await fs.writeFile(destination, 'corrupt cached archive');
        globalThis.fetch = async () => {
            requests += 1;
            return new Response('corrupt downloaded archive');
        };

        await assert.rejects(
            downloadNasrFile('https://example.test/APT_CSV.zip', destination),
            /unzip/
        );
        assert.equal(requests, 1);
        await assert.rejects(fs.access(destination), /ENOENT/);
    } finally {
        globalThis.fetch = originalFetch;
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('NASR normalization produces airport, fix, VFR waypoint, NAVAID, and airway products', () => {
    const effective = '2026/09/03';
    const products = buildNasrProducts({
        ...preferredRouteInput(),
        airports: csv(
            [
                'EFF_DATE', 'SITE_NO', 'SITE_TYPE_CODE', 'ARPT_ID', 'ICAO_ID', 'ARPT_NAME',
                'CITY', 'STATE_CODE', 'COUNTRY_CODE', 'FACILITY_USE_CODE', 'ARPT_STATUS',
                'LAT_DECIMAL', 'LONG_DECIMAL', 'ELEV', 'TWR_TYPE_CODE', 'CHART_NAME', 'NOTAM_ID'
            ],
            [
                [effective, '00001.', 'A', 'PAO', 'KPAO', 'PALO ALTO', 'PALO ALTO', 'CA',
                    'US', 'PU', 'O', '37.4611', '-122.115', '6.8', 'ATCT', 'SAN FRANCISCO', 'PAO'],
                [effective, '00001.', 'H', 'HPAO', '', 'PALO ALTO HELIPORT', 'PALO ALTO', 'CA',
                    'US', 'PR', 'O', '37.462', '-122.116', '7', '', 'SAN FRANCISCO', '']
            ]
        ),
        runways: csv(
            [
                'EFF_DATE', 'SITE_NO', 'SITE_TYPE_CODE', 'RWY_ID', 'RWY_LEN', 'RWY_WIDTH',
                'SURFACE_TYPE_CODE'
            ],
            [
                [effective, '00001.', 'A', '13/31', 2443, 70, 'ASPH'],
                [effective, '00001.', 'H', 'H1', 50, 50, 'CONC']
            ]
        ),
        runwayEnds: csv(
            ['EFF_DATE', 'SITE_NO', 'SITE_TYPE_CODE', 'RWY_ID', 'RWY_END_ID',
                'TRUE_ALIGNMENT', 'RIGHT_HAND_TRAFFIC_PAT_FLAG'],
            [
                [effective, '00001.', 'A', '13/31', '13', 140, 'Y'],
                [effective, '00001.', 'A', '13/31', '31', 320, 'N'],
                [effective, '00001.', 'H', 'H1', 'H1', '', ''],
                [effective, 'unrelated', 'A', '13/31', '13', 999, 'Y']
            ]
        ),
        fixes: csv(
            [
                'EFF_DATE', 'FIX_ID', 'ICAO_REGION_CODE', 'STATE_CODE', 'COUNTRY_CODE',
                'LAT_DECIMAL', 'LONG_DECIMAL', 'FIX_USE_CODE', 'CHARTS'
            ],
            [
                [effective, 'VPABC', 'K2', 'CA', 'US', '37.5', '-122.5', 'VFR  ', 'SECTIONAL'],
                [effective, 'VPLUC', 'K1', 'WY', 'US', '43.8', '-110.5', 'WP   ', 'SPECIAL IAP']
            ]
        ),
        navaids: csv(
            [
                'EFF_DATE', 'NAV_ID', 'NAV_TYPE', 'NAME', 'CITY', 'STATE_CODE', 'COUNTRY_CODE',
                'LAT_DECIMAL', 'LONG_DECIMAL', 'NAV_STATUS', 'FREQ'
            ],
            [
                [effective, 'MB', 'NDB', 'JEPOT', 'MANISTEE', 'MI', 'US', '44.27', '-86.25',
                    'OPERATIONAL IFR', '245'],
                [effective, 'MB', 'NDB', 'OLSTE', 'SAGINAW', 'MI', 'US', '43.53', '-84.08',
                    'OPERATIONAL IFR', '278']
            ]
        ),
        airways: csv(
            ['EFF_DATE', 'REGULATORY', 'AWY_LOCATION', 'AWY_ID', 'UPDATE_DATE', 'AIRWAY_STRING'],
            [
                [effective, 'Y', 'C', 'V25', '2026/08/01', 'SNS ENI'],
                [effective, 'N', 'C', 'V25', '2026/08/02', 'OAK SFO']
            ]
        ),
        airwaySegments: csv(
            [
                'EFF_DATE', 'REGULATORY', 'AWY_LOCATION', 'AWY_ID', 'POINT_SEQ', 'FROM_POINT',
                'FROM_PT_TYPE', 'TO_POINT', 'MAG_COURSE', 'MAG_COURSE_DIST',
                'MIN_ENROUTE_ALT', 'MAX_AUTH_ALT', 'AWY_SEG_GAP_FLAG'
            ],
            [
                [effective, 'Y', 'C', 'V25', 10, 'SNS', 'VOR', 'ENI', '321.5', '92.4',
                    '5000', '17500', 'N'],
                [effective, 'N', 'C', 'V25', 10, 'OAK', 'VOR', 'SFO', '270', '11',
                    '3000', '17500', 'Y']
            ]
        )
    });

    assert.equal(products.effectiveDate, '2026-09-03');
    assert.equal(products.airports.features.length, 2);
    assert.equal(new Set(products.airports.features.map(feature => feature.id)).size, 2);
    assert.equal(products.airports.features[0].properties.longestRunwayFt, 2443);
    assert.deepEqual(products.airports.features[0].properties.runways, [{
        id: '13/31',
        lengthFt: 2443,
        widthFt: 70,
        surface: 'ASPH',
        ends: [
            { id: '13', trueHeadingDeg: 140, trafficPattern: 'right' },
            { id: '31', trueHeadingDeg: 320, trafficPattern: 'left' }
        ]
    }]);
    assert.equal(products.airports.features[1].properties.longestRunwayFt, 50);
    assert.deepEqual(products.airports.features[1].properties.runways, [{
        id: 'H1',
        lengthFt: 50,
        widthFt: 50,
        surface: 'CONC',
        ends: [{ id: 'H1' }]
    }]);
    assert.equal(products.airports.features[0].properties.towered, true);
    assert.equal(products.fixes.features.length, 2);
    assert.equal(products.vfrWaypoints.features.length, 1);
    assert.equal(products.vfrWaypoints.features[0].properties.ident, 'VPABC');
    assert.equal(products.fixes.features[1].properties.kind, 'fix');
    assert.equal(products.navaids.features.length, 2);
    assert.equal(new Set(products.navaids.features.map(feature => feature.id)).size, 2);
    assert.equal(products.navaids.features[0].properties.frequency, '245');
    assert.equal(products.airways.airways.length, 2);
    assert.equal(new Set(products.airways.airways.map(airway => airway.id)).size, 2);
    assert.equal(products.airways.airways[0].regulatory, true);
    assert.deepEqual(products.airways.airways[0].points, ['SNS', 'ENI']);
    assert.equal((products.airways.airways[0].segments as any[])[0].meaFt, 5000);
    assert.equal((products.airways.airways[0].segments as any[])[0].gap, false);
    assert.equal(products.airways.airways[1].regulatory, false);
    assert.deepEqual(products.airways.airways[1].points, ['OAK', 'SFO']);
    assert.equal((products.airways.airways[1].segments as any[])[0].meaFt, 3000);
    assert.equal((products.airways.airways[1].segments as any[])[0].gap, true);
});

test('VOR station declination retains published east/west alignment and never treats missing variation as zero', () => {
    const cases: Array<[string | number, string, string, number | undefined]> = [
        [15, 'E', 'VOR/DME', 15], [10, 'W', 'VORTAC', -10], [0, '', 'VOR', 0],
        [0, 'INVALID', 'VOR', undefined], [15, 'INVALID', 'VOR', undefined],
        ['', 'E', 'VOR', undefined], [15, '', 'VOR', undefined],
        [181, 'E', 'VOR', undefined], [-15, 'E', 'VOR', undefined],
        [15, 'E', 'NDB', undefined], [15, 'E', 'VOT', undefined],
    ];
    for (const [degrees, hemisphere, type, expected] of cases) {
        const products = buildNasrProducts(preferredRouteInput({ navaids: recordCsv([
            'EFF_DATE', 'NAV_ID', 'NAV_TYPE', 'LAT_DECIMAL', 'LONG_DECIMAL', 'MAG_VARN', 'MAG_VARN_HEMIS'
        ], [{ EFF_DATE: '2026/09/03', NAV_ID: 'TEST', NAV_TYPE: type, LAT_DECIMAL: 37, LONG_DECIMAL: -122,
            MAG_VARN: degrees, MAG_VARN_HEMIS: hemisphere }]) }));
        assert.equal(products.navaids.features[0].properties.stationDeclinationDeg, expected);
    }
});

const preferredHeaders = [
    'EFF_DATE', 'ORIGIN_ID', 'ORIGIN_CITY', 'ORIGIN_STATE_CODE', 'ORIGIN_COUNTRY_CODE',
    'DSTN_ID', 'DSTN_CITY', 'DSTN_STATE_CODE', 'DSTN_COUNTRY_CODE', 'PFR_TYPE_CODE', 'ROUTE_NO',
    'SPECIAL_AREA_DESCRIP', 'ALT_DESCRIP', 'AIRCRAFT', 'HOURS', 'ROUTE_DIR_DESCRIP', 'DESIGNATOR',
    'NAR_TYPE', 'INLAND_FAC_FIX', 'COASTAL_FIX', 'DESTINATION', 'ROUTE_STRING'
];
const preferredSegmentHeaders = [
    'EFF_DATE', 'ORIGIN_ID', 'DSTN_ID', 'PFR_TYPE_CODE', 'ROUTE_NO', 'SEGMENT_SEQ', 'SEG_VALUE',
    'SEG_TYPE', 'STATE_CODE', 'COUNTRY_CODE', 'ICAO_REGION_CODE', 'NAV_TYPE', 'NEXT_SEG'
];
const routeRow = {
    EFF_DATE: '2026/09/03', ORIGIN_ID: 'SBA', ORIGIN_CITY: 'SANTA BARBARA', ORIGIN_STATE_CODE: 'CA',
    ORIGIN_COUNTRY_CODE: 'US', DSTN_ID: 'SMO', DSTN_CITY: 'SANTA MONICA', DSTN_STATE_CODE: 'CA',
    DSTN_COUNTRY_CODE: 'US', PFR_TYPE_CODE: 'TEC', ROUTE_NO: 4,
    SPECIAL_AREA_DESCRIP: 'SBA TO SMO', ALT_DESCRIP: 'PQ70', DESIGNATOR: 'SBAQ12',
    ROUTE_STRING: 'KWANG CMA VNY V186 DARTS'
};
const segmentRow = {
    EFF_DATE: '2026/09/03', ORIGIN_ID: 'SBA', DSTN_ID: 'SMO', PFR_TYPE_CODE: 'TEC', ROUTE_NO: 4,
    SEGMENT_SEQ: 5, SEG_VALUE: 'KWANG', SEG_TYPE: 'FIX', STATE_CODE: 'CA', COUNTRY_CODE: 'US',
    ICAO_REGION_CODE: 'K2', NEXT_SEG: 'CMA'
};
const frequencyHeaders = [
    'EFF_DATE', 'FACILITY_TYPE', 'SERVICED_FACILITY', 'SERVICED_SITE_TYPE',
    'SERVICED_STATE', 'SERVICED_COUNTRY', 'FREQ', 'FREQ_USE'
];
const frequencyRow = {
    EFF_DATE: '2026/09/03', FACILITY_TYPE: 'ATCT', SERVICED_FACILITY: 'SBA',
    SERVICED_SITE_TYPE: 'AIRPORT', SERVICED_STATE: 'CA', SERVICED_COUNTRY: 'US',
    FREQ: '119.7', FREQ_USE: 'LCL/P'
};
function recordCsv(headers: string[], rows: Record<string, string | number>[]): string {
    return csv(headers, rows.map(row => headers.map(header => row[header] ?? '')));
}
function preferredRouteInput(overrides: Partial<NasrInput> = {}): NasrInput {
    const date = { EFF_DATE: '2026/09/03' };
    const point = { ...date, LAT_DECIMAL: 37, LONG_DECIMAL: -122 };
    const table = row => recordCsv(Object.keys(row), [row]);
    return {
        airports: table({ ...point, SITE_NO: '00001.', SITE_TYPE_CODE: 'A', ARPT_ID: 'SBA' }),
        runways: table({ ...date, SITE_NO: '00001.', SITE_TYPE_CODE: 'A', RWY_ID: '13/31' }),
        runwayEnds: table({ ...date, SITE_NO: '00001.', SITE_TYPE_CODE: 'A', RWY_ID: '13/31', RWY_END_ID: '13' }),
        fixes: table({ ...point, FIX_ID: 'TESTF', FIX_USE_CODE: 'WP' }),
        frequencies: recordCsv(frequencyHeaders, [frequencyRow]),
        navaids: table({ ...point, NAV_ID: 'TESTN', NAV_TYPE: 'VOR' }),
        airways: table({ ...date, REGULATORY: 'Y', AWY_LOCATION: 'C', AWY_ID: 'V1' }),
        airwaySegments: table({ ...date, REGULATORY: 'Y', AWY_LOCATION: 'C', AWY_ID: 'V1', POINT_SEQ: 1, FROM_POINT: 'TESTN', FROM_PT_TYPE: 'VOR', TO_POINT: '' }),
        preferredRoutes: recordCsv(preferredHeaders, [routeRow]),
        preferredRouteSegments: recordCsv(preferredSegmentHeaders, [segmentRow]),
        ...overrides
    };
}

test('NASR frequency input rejects empty records, missing columns, and invalid effective dates', () => {
    for (const [frequencies, expected] of [
        [recordCsv(frequencyHeaders, []), /FRQ.csv contains no frequency records/],
        [recordCsv(frequencyHeaders.filter(field => field !== 'FREQ_USE'), [frequencyRow]), /FRQ.csv is missing FREQ_USE/],
        [recordCsv(frequencyHeaders.filter(field => field !== 'EFF_DATE'), [frequencyRow]), /missing EFF_DATE/],
        [recordCsv(frequencyHeaders, [{ ...frequencyRow, EFF_DATE: ' ' }]), /missing or mismatched effective date/],
        [recordCsv(frequencyHeaders, [{ ...frequencyRow, EFF_DATE: '2026/08/06' }]), /one effective date/]
    ] as const) {
        assert.throws(() => buildNasrProducts(preferredRouteInput({ frequencies })), expected);
    }
});

test('required NASR tables reject missing schemas, empty input and undated rows before projection', () => {
    const valid = preferredRouteInput();
    assert.throws(() => buildNasrProducts({ ...valid, airports: valid.airports.replace('LAT_DECIMAL', 'BAD_LATITUDE') }), /missing LAT_DECIMAL/);
    for (const key of Object.keys(valid) as (keyof NasrInput)[]) {
        if (key !== 'preferredRouteSegments') assert.throws(() => buildNasrProducts({ ...valid,
            [key]: valid[key].split('\r\n')[0] + '\r\n' }), /contains no/);
        assert.throws(() => buildNasrProducts({ ...valid, [key]: valid[key].replaceAll('2026/09/03', '') }), /effective date/);
    }
});

test('excluded NASR points and dependent rows remain accounted for with source row identities', () => {
    const valid = preferredRouteInput();
    const data = buildNasrProducts({ ...valid, airports: valid.airports.replace('"37"', '""') });
    assert.equal(data.airports.features.length, 0);
    assert.deepEqual(data.coverage.APT_BASE, { sourceRows: 1, exportedRows: 0, excludedRows: 1 });
    assert.equal(data.excluded.find(row => row.table === 'APT_BASE')?.reason, 'unavailable-coordinates');
    assert.equal(data.coverage.APT_RWY.excludedRows, 1);
    assert.equal(data.coverage.APT_RWY_END.excludedRows, 1);
    for (const ledger of Object.values(data.coverage)) assert.equal(ledger.exportedRows + ledger.excludedRows, ledger.sourceRows);
});

test('preferred routes retain directional variants, coded restrictions, NAR fields, and ordered segments', () => {
    const products = buildNasrProducts(preferredRouteInput({
        preferredRoutes: recordCsv(preferredHeaders, [
            routeRow,
            { ...routeRow, ROUTE_NO: 5, DESIGNATOR: 'SBAQ13', ALT_DESCRIP: 'J110M90',
                ROUTE_STRING: 'HENER FIM V186 DARTS' },
            { ...routeRow, PFR_TYPE_CODE: 'L', DESIGNATOR: '', AIRCRAFT: 'PROPS LESS THAN 210 KTS IAS',
                HOURS: '1100-0400', ROUTE_DIR_DESCRIP: 'EAST FLOW' },
            { ...routeRow, ORIGIN_ID: 'SMO', DSTN_ID: 'SBA' },
            { EFF_DATE: routeRow.EFF_DATE, ORIGIN_ID: 'ALLEX', DSTN_ID: 'ALLRY', PFR_TYPE_CODE: 'NAR',
                ROUTE_NO: 1, NAR_TYPE: 'COMMON', INLAND_FAC_FIX: 'ALLEX', COASTAL_FIX: 'ALLRY',
                DESTINATION: 'ANDREWS', ROUTE_STRING: 'ALLEX ALLRY' }
        ]),
        preferredRouteSegments: recordCsv(preferredSegmentHeaders, [
            { ...segmentRow, SEGMENT_SEQ: 10, SEG_VALUE: 'CMA', SEG_TYPE: 'NAVAID',
                NAV_TYPE: 'VOR/DME', NEXT_SEG: 'VNY' },
            { ...segmentRow, ROUTE_NO: 5, SEG_VALUE: 'HENER', NEXT_SEG: 'FIM' },
            { ...segmentRow, PFR_TYPE_CODE: 'L', SEG_VALUE: 'LOWRT', NEXT_SEG: '' },
            segmentRow
        ])
    }));
    const { preferredRoutes } = products;
    assert.equal(products.airways.type, 'ZLayerAirways');
    assert.equal(preferredRoutes.type, 'ZLayerPreferredRoutes');
    assert.equal(preferredRoutes.metadata.effectiveDate, '2026-09-03');
    assert.equal(preferredRoutes.metadata.source, 'FAA 28-day NASR subscription');
    const [first, second, low, reverse, nar] = preferredRoutes.routes;
    assert.equal(new Set(preferredRoutes.routes.map(route => route.id)).size, 5);
    assert.equal(first.id, 'preferred-route:SBA:SMO:TEC:4');
    assert.equal(first.originId, 'SBA');
    assert.equal(first.destinationId, 'SMO');
    assert.equal(first.originCity, 'SANTA BARBARA');
    assert.equal(first.destinationState, 'CA');
    assert.equal(first.originCountry, 'US');
    assert.equal(first.routeType, 'TEC');
    assert.equal(first.routeNumber, 4);
    assert.equal(first.area, 'SBA TO SMO');
    assert.equal(first.altitude, 'PQ70');
    assert.equal(first.route, 'KWANG CMA VNY V186 DARTS');
    assert.equal(first.designator, 'SBAQ12');
    assert.equal(Object.hasOwn(first, 'aircraft'), false);
    assert.deepEqual(first.segments, [
        { sequence: 5, value: 'KWANG', type: 'FIX', state: 'CA', country: 'US',
            icaoRegion: 'K2', next: 'CMA' },
        { sequence: 10, value: 'CMA', type: 'NAVAID', state: 'CA', country: 'US',
            icaoRegion: 'K2', navaidType: 'VOR/DME', next: 'VNY' }
    ]);
    assert.equal(second.altitude, 'J110M90');
    assert.equal((second.segments as any[])[0].value, 'HENER');
    assert.equal((low.segments as any[])[0].value, 'LOWRT');
    assert.equal(low.aircraft, 'PROPS LESS THAN 210 KTS IAS');
    assert.equal(low.hours, '1100-0400');
    assert.equal(low.direction, 'EAST FLOW');
    assert.equal(reverse.id, 'preferred-route:SMO:SBA:TEC:4');
    assert.deepEqual(reverse.segments, []);
    assert.equal(nar.narType, 'COMMON');
    assert.equal(nar.inlandFix, 'ALLEX');
    assert.equal(nar.coastalFix, 'ALLRY');
    assert.equal(nar.narDestination, 'ANDREWS');
    assert.deepEqual(nar.segments, []);
});

test('preferred routes reject ambiguous joins and mismatched cycles', () => {
    const routes = (rows: Record<string, string | number>[]) => ({
        preferredRoutes: recordCsv(preferredHeaders, rows)
    });
    const segments = (rows: Record<string, string | number>[]) => ({
        preferredRouteSegments: recordCsv(preferredSegmentHeaders, rows)
    });
    const cases: [Partial<NasrInput>, RegExp][] = [
        [routes([]), /no preferred routes/],
        [routes([routeRow, routeRow]), /duplicate/],
        [routes([{ ...routeRow, DSTN_ID: '' }]), /invalid route identity/],
        [routes([{ ...routeRow, ROUTE_NO: 'bad' }]), /invalid route identity/],
        [segments([{ ...segmentRow, ROUTE_NO: 5 }]), /no parent route/],
        [segments([segmentRow, segmentRow]), /duplicate segment sequence/],
        [segments([{ ...segmentRow, SEGMENT_SEQ: '' }]), /invalid segment/],
        [segments([{ ...segmentRow, SEG_VALUE: '' }]), /invalid segment/],
        [routes([{ ...routeRow, EFF_DATE: '' }]), /missing or mismatched effective date/],
        [segments([{ ...segmentRow, EFF_DATE: '  ' }]), /missing or mismatched effective date/],
        [{ preferredRoutes: recordCsv(preferredHeaders.filter(header => header !== 'EFF_DATE'), [routeRow]) },
            /missing EFF_DATE/],
        [{ preferredRouteSegments: recordCsv(preferredSegmentHeaders.filter(header => header !== 'EFF_DATE'), [segmentRow]) },
            /missing EFF_DATE/],
        [routes([{ ...routeRow, EFF_DATE: '2026/08/06' }]), /one effective date/],
        [segments([{ ...segmentRow, EFF_DATE: '2026/08/06' }]), /one effective date/]
    ];
    for (const [overrides, error] of cases) {
        assert.throws(() => buildNasrProducts(preferredRouteInput(overrides)), error);
    }
});

test('NASR cycle build packages navigation, CIFP approaches, magnetic model and filed history offline and atomically', async t => {
    t.mock.method(globalThis, 'fetch', () => { throw new Error('Local navigation builds must stay offline'); });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-nasr-pfr-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const sourceDir = path.join(root, 'sources');
    await fs.mkdir(sourceDir);
    await fs.copyFile(new URL('./fixtures/terminal-cifp.txt', import.meta.url), path.join(sourceDir, 'FAACIFP18'));
    const input = preferredRouteInput({
        airports: csv(
            ['EFF_DATE', 'SITE_NO', 'SITE_TYPE_CODE', 'ARPT_ID', 'ICAO_ID', 'STATE_CODE', 'COUNTRY_CODE',
                'LAT_DECIMAL', 'LONG_DECIMAL'],
            [
                ['2026/09/03', '00001.', 'A', 'SBA', 'KSBA', 'CA', 'US', 34.4278, -119.84],
                ['2026/09/03', '00002.', 'A', 'SMO', 'KSMO', 'CA', 'US', 34.015, -118.4511]
            ]
        ),
        navaids: csv(
            ['EFF_DATE', 'NAV_ID', 'NAV_TYPE', 'LAT_DECIMAL', 'LONG_DECIMAL', 'MAG_VARN', 'MAG_VARN_HEMIS'],
            [
                ['2026/09/03', 'EAST', 'VOR/DME', 34.2, -119.1, 15, 'E'],
                ['2026/09/03', 'WEST', 'VORTAC', 37.5, -77.3, 10, 'W'],
                ['2026/09/03', 'ZERO', 'VOR', 40, -90, 0, ''],
                ['2026/09/03', 'MISSING', 'VOR', 39, -89, '', '']
            ]
        )
    });
    const terminal = JSON.parse(await fs.readFile(new URL('./fixtures/terminal-procedures.json', import.meta.url), 'utf8'));
    const files: Record<string, string> = {
        'APT_BASE.csv': input.airports, 'APT_RWY.csv': input.runways, 'APT_RWY_END.csv': input.runwayEnds,
        'FRQ.csv': input.frequencies, 'FIX_BASE.csv': input.fixes, 'NAV_BASE.csv': input.navaids,
        'AWY_BASE.csv': input.airways, 'AWY_SEG_ALT.csv': input.airwaySegments,
        'PFR_BASE.csv': input.preferredRoutes, 'PFR_SEG.csv': input.preferredRouteSegments,
        'DP_BASE.csv': terminal.departures, 'DP_APT.csv': terminal.departureAirports, 'DP_RTE.csv': terminal.departureRoutes,
        'STAR_BASE.csv': terminal.arrivals, 'STAR_APT.csv': terminal.arrivalAirports, 'STAR_RTE.csv': terminal.arrivalRoutes
    };
    for (const [name, contents] of Object.entries(files)) await fs.writeFile(path.join(sourceDir, name), contents);
    const archive = async (group: string) => promisify(execFile)('zip', [
        '-q', `${group}_CSV.zip`, ...Object.keys(files).filter(name => name.startsWith(`${group}_`) || name === `${group}.csv`)
    ], { cwd: sourceDir });
    for (const group of ['APT', 'FRQ', 'FIX', 'NAV', 'AWY', 'PFR', 'DP', 'STAR']) await archive(group);
    const routeHistorySource = path.join(root, 'routes.sqlite');
    const database = new DatabaseSync(routeHistorySource);
    database.exec(await fs.readFile(new URL('./fixtures/route-history.sql', import.meta.url), 'utf8'));
    database.close();
    const options = { output: path.join(root, 'output'), sourceDir, cycle: '2026-09-03', routeHistorySource };
    await buildNasrData(options);
    const cycleDir = path.join(options.output, 'charts', options.cycle);
    const nav = path.join(cycleDir, 'nav');
    const originalManifest = await fs.readFile(path.join(nav, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(originalManifest);
    const airportData = JSON.parse(await fs.readFile(path.join(nav, manifest.products.find(p => p.id === 'airports').file), 'utf8'));
    assert.deepEqual(airportData.features.map(feature => feature.properties.frequencies), [
        [{ type: 'TOWER', frequencyMHz: 119.7, use: 'LCL/P' }], []
    ]);
    assert.equal(manifest.sourceArchives.find(source => source.group === 'FRQ').filename, 'FRQ_CSV.zip');
    const magneticProduct = manifest.products.find(product => product.id === 'magnetic-model');
    assert.match(magneticProduct.file, /^magnetic-model\.[a-f0-9]{64}\.json$/);
    assert.equal(magneticProduct.count, 90);
    assert.equal(magneticProduct.model, 'WMM-2025');
    const modelBytes = await fs.readFile(path.join(nav, magneticProduct.file));
    assert.equal(magneticProduct.bytes, modelBytes.length);
    assert.equal(magneticProduct.sha256, createHash('sha256').update(modelBytes).digest('hex'));
    const magneticModel = JSON.parse(modelBytes.toString());
    assert.equal(magneticModel.type, 'ZLayerMagneticModel');
    assert.equal(magneticModel.effectiveDate, options.cycle);
    assert.equal(magneticModel.coverage, 'global');
    assert.equal(magneticModel.coefficients.length, magneticProduct.count);
    assert.equal(magneticProduct.validFrom, '2025-01-01');
    assert.equal(magneticProduct.validUntil, '2030-01-01');
    assert.equal(magneticModel.validUntil, magneticProduct.validUntil);
    assert.deepEqual(magneticProduct.source, magneticModel.source);
    assert.equal(magneticModel.source.sha256,
        'dfa8597825af4e0b87ff4198a5b4fb661b3c49f4cd090cd0164e0259b075582f');
    const navaidProduct = manifest.products.find(product => product.id === 'navaids');
    assert.equal(navaidProduct.count, 4);
    assert.match(navaidProduct.file, /^navaids\.[a-f0-9]{64}\.geojson$/);
    const navaidData = JSON.parse(await fs.readFile(path.join(nav, navaidProduct.file), 'utf8'));
    assert.deepEqual(navaidData.features.map(feature => feature.properties.stationDeclinationDeg), [15, -10, 0, undefined]);
    assert.equal(Object.hasOwn(navaidData.features[3].properties, 'stationDeclinationDeg'), false);
    const terminalProduct = manifest.products.find(product => product.id === 'terminal-procedures');
    const terminalBytes = await fs.readFile(path.join(nav, terminalProduct.file));
    assert.equal(terminalProduct.count, 2);
    assert.equal(terminalProduct.bytes, terminalBytes.length);
    assert.equal(terminalProduct.sha256, createHash('sha256').update(terminalBytes).digest('hex'));
    const cifpSource = manifest.sourceArchives.find(source => source.group === 'CIFP');
    assert.equal(cifpSource.recordFile.sha256, createHash('sha256')
        .update(await fs.readFile(path.join(sourceDir, 'FAACIFP18'))).digest('hex'));
    const procedureData = JSON.parse(await fs.readFile(path.join(nav, terminalProduct.file), 'utf8'));
    assert.deepEqual(procedureData.procedures.map(procedure => procedure.ident), ['SPTNS1', 'OHSEA3']);
    assert.equal(procedureData.approaches.type, 'ZLayerApproachRoutes');
    assert.equal(procedureData.approaches.metadata.effectiveDate, '2026-09-03');
    assert.equal(procedureData.approaches.procedures.length, 7);
    assert.ok(procedureData.approaches.procedures.some(procedure => procedure.id === 'KVGT:I12L'));
    assert.ok(procedureData.codedProcedures.procedures.some(procedure => procedure.kind === 'departure'));
    assert.ok(procedureData.codedProcedures.procedures.some(procedure => procedure.kind === 'arrival'));
    assert.deepEqual(terminalProduct.coverage, procedureData.coverage);
    assert.equal(procedureData.approaches.procedures.find(procedure => procedure.id === 'KSFO:I28R').final.at(-1).fix.ident, 'VIKYU');
    const arc = procedureData.approaches.procedures.find(procedure => procedure.id === 'KSNS:I31')
        .transitions.find(transition => transition.id === 'SNS2').legs.find(leg => leg.path === 'AF');
    assert.equal(arc.radiusNm, 22);
    assert.deepEqual(arc.center, [-121.60318333333333, 36.66383888888889]);
    const historyProduct = manifest.products.find(product => product.id === 'route-history');
    assert.match(historyProduct.file, /^route-history\.json\.[a-f0-9]{64}\.gz$/);
    assert.equal(historyProduct.compression, 'gzip');
    assert.equal(historyProduct.count, 2);
    const originalHistory = await fs.readFile(path.join(nav, historyProduct.file));
    assert.equal(originalHistory.length, historyProduct.bytes);
    const history = JSON.parse(gunzipSync(originalHistory).toString());
    assert.equal(history.type, 'ZLayerRouteHistory');
    assert.equal(history.version, 1);
    assert.equal(history.effectiveDate, options.cycle);
    assert.equal(history.countBasis, 'source-filed-route-use-count');
    assert.equal(history.observationRange.lastSeen, '2026-01-25');
    assert.equal(manifest.products.find(product => product.id === 'preferred-routes').count, 1);
    const source = manifest.sourceArchives.find(source => source.group === 'PFR');
    assert.equal(source.filename, 'PFR_CSV.zip');
    assert.match(source.url, /PFR_CSV\.zip$/);
    const bytes = await fs.readFile(path.join(cycleDir, 'nasr', source.filename));
    assert.equal(source.sha256, createHash('sha256').update(bytes).digest('hex'));
    const originalRoutes = await fs.readFile(path.join(nav, manifest.products.find(p => p.id === 'preferred-routes').file), 'utf8');
    assert.deepEqual(JSON.parse(originalRoutes), buildNasrProducts(input).preferredRoutes);
    const snapshot = new Map(await Promise.all((await fs.readdir(nav)).map(async name =>
        [name, await fs.readFile(path.join(nav, name))] as const)));
    const assertUnchanged = async () => {
        assert.deepEqual((await fs.readdir(nav)).sort(), [...snapshot.keys()].sort());
        for (const [name, bytes] of snapshot) assert.deepEqual(await fs.readFile(path.join(nav, name)), bytes, name);
        assert.deepEqual((await fs.readdir(cycleDir)).sort(), ['nasr', 'nav']);
    };

    const cifpFile = path.join(sourceDir, 'FAACIFP18'), cifp = await fs.readFile(cifpFile, 'utf8');
    await fs.rm(cifpFile);
    await assert.rejects(buildNasrData(options), /CIFP is required/);
    await assertUnchanged();
    await fs.writeFile(cifpFile, cifp);

    const truncatedCifp = cifp.split('\n').map(line => line.slice(6, 10) === 'KSFO' &&
        line.slice(13, 19).trim() === 'I28R' && line.slice(29, 34) === 'AXMUL' && line.slice(47, 49) === 'CF'
        ? line.slice(0, -1) : line).join('\n');
    await fs.writeFile(cifpFile, truncatedCifp);
    await assert.rejects(buildNasrData(options), /CIFP record.*132/);
    await assertUnchanged();
    await fs.writeFile(cifpFile, cifp);

    for (const [group, expected] of [
        ['FRQ', /FRQ.csv contains no frequency records/],
        ['DP', /BASE\.csv contains no procedures/],
        ['STAR', /BASE\.csv contains no procedures/]
    ] as const) {
        const names = Object.keys(files).filter(name => name.startsWith(`${group}_`) || name === `${group}.csv`);
        for (const name of names) await fs.writeFile(path.join(sourceDir, name), files[name].split('\n')[0] + '\n');
        await archive(group);
        await assert.rejects(buildNasrData(options), expected);
        await assertUnchanged();
        for (const name of names) await fs.writeFile(path.join(sourceDir, name), files[name]);
        await archive(group);
    }

    await fs.rename(routeHistorySource, `${routeHistorySource}.saved`);
    await fs.writeFile(routeHistorySource, 'invalid database');
    await assert.rejects(buildNasrData(options), /not a database/);
    await assertUnchanged();
    await fs.rename(`${routeHistorySource}.saved`, routeHistorySource);

    await fs.writeFile(path.join(sourceDir, 'PFR_SEG.csv'), recordCsv(preferredSegmentHeaders, [
        { ...segmentRow, ROUTE_NO: 99 }
    ]));
    await archive('PFR');
    await assert.rejects(buildNasrData(options), /no parent route/);
    await assertUnchanged();
});
