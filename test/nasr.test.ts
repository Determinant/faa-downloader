import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    discoverCurrentNasrCycle,
    discoverNasrGroupUrls,
    downloadNasrFile,
    pruneNasrCycles
} from '../download-nasr.ts';
import { parseCsvRecords, parseCsvRows } from '../lib/csv.ts';
import { buildNasrProducts } from '../lib/nasr.ts';
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

    const cycle = ['APT', 'FIX', 'NAV', 'AWY']
        .map(group => `<a href="https://nfdc.faa.gov/data_2026_${group}_CSV.zip">${group}</a>`)
        .join('');
    assert.deepEqual(
        discoverNasrGroupUrls(cycle, 'https://www.faa.gov/cycle/'),
        {
            APT: 'https://nfdc.faa.gov/data_2026_APT_CSV.zip',
            FIX: 'https://nfdc.faa.gov/data_2026_FIX_CSV.zip',
            NAV: 'https://nfdc.faa.gov/data_2026_NAV_CSV.zip',
            AWY: 'https://nfdc.faa.gov/data_2026_AWY_CSV.zip'
        }
    );
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
                'MIN_ENROUTE_ALT', 'MAX_AUTH_ALT'
            ],
            [
                [effective, 'Y', 'C', 'V25', 10, 'SNS', 'VOR', 'ENI', '321.5', '92.4',
                    '5000', '17500'],
                [effective, 'N', 'C', 'V25', 10, 'OAK', 'VOR', 'SFO', '270', '11',
                    '3000', '17500']
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
    assert.equal(products.airways.airways[1].regulatory, false);
    assert.deepEqual(products.airways.airways[1].points, ['OAK', 'SFO']);
    assert.equal((products.airways.airways[1].segments as any[])[0].meaFt, 3000);
});
