import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { buildObstacles, DAILY_DOF_URL } from '../build-obstacles.ts';
import { sha256File } from '../lib/fs-utils.ts';
import { writeObstacleGeoJson } from '../lib/obstacles.ts';

const execFileAsync = promisify(execFile);
const columns = 'OAS,VERIFIED STATUS,COUNTRY,STATE,CITY,LATDEC,LONDEC,DMSLAT,DMSLON,TYPE,QUANTITY,AGL,AMSL,LIGHTING,ACCURACY,MARKING,FAA STUDY,ACTION,JDATE'.split(',');
const original = {
    OAS: '06-000001', 'VERIFIED STATUS': 'O', COUNTRY: 'US', STATE: 'CA',
    CITY: ' TEST CITY  ', LATDEC: '36.250000', LONDEC: '-116.750000',
    DMSLAT: '36 15 00.00N', DMSLON: '116 45 00.00W', TYPE: 'TOWER  ',
    QUANTITY: '1', AGL: '00000', AMSL: '-00166', LIGHTING: 'R', ACCURACY: ' 1A',
    MARKING: 'P', 'FAA STUDY': '2024AWP00001OE', ACTION: 'C', JDATE: '2024060 '
};
const csvValue = (value: string) => /[,"\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
const record = (changes: Record<string, string> = {}) => {
    const row = { ...original, ...changes };
    return columns.map(column => csvValue(row[column])).join(',');
};
const csv = (...rows: string[]) => `${columns.join(',')}\r\n${rows.join('\r\n')}\r\n`;
async function setup(t: { after: (fn: () => Promise<void>) => void }) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-obstacles-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return { root, output: path.join(root, 'dist'), sourceFile: path.join(root, 'daily.zip'),
        csvFile: path.join(root, 'DOF.CSV'), destination: path.join(root, 'obstacles.geojson.gz') };
}
async function archive(options: Awaited<ReturnType<typeof setup>>, contents: string, entry = 'DOF.CSV') {
    await fs.writeFile(path.join(options.root, entry), contents, 'latin1');
    await fs.rm(options.sourceFile, { force: true });
    await execFileAsync('zip', ['-q', options.sourceFile, entry], { cwd: options.root });
    return fs.readFile(options.sourceFile);
}
const readExport = async (file: string) => JSON.parse(gunzipSync(await fs.readFile(file)).toString());

test('obstacles preserve verified/unverified records, units, unknowns, dates and Windows-1252 text', async t => {
    const options = await setup(t);
    await fs.writeFile(options.csvFile, csv(record(), record({
        OAS: 'AS-A00002', 'VERIFIED STATUS': 'U', COUNTRY: 'AS', STATE: '',
        CITY: 'O\x92BRIEN, "ISLAND"', LATDEC: '-14.355278', LONDEC: '174.138873',
        QUANTITY: '9', AGL: '00240', AMSL: '00241', LIGHTING: 'U', MARKING: 'U',
        ACCURACY: '   ', 'FAA STUDY': '', ACTION: 'A', JDATE: '2024366'
    })), 'latin1');
    const stats = await writeObstacleGeoJson(options.csvFile, options.destination);
    const data = await readExport(options.destination);
    assert.equal(data.type, 'FeatureCollection');
    assert.equal(stats.count, 2);
    assert.equal(stats.verifiedCount, 1);
    assert.equal(stats.unverifiedCount, 1);
    assert.deepEqual(stats.bbox, [-116.75, -14.355278, 174.138873, 36.25]);
    assert.equal(stats.uncompressedBytes, gunzipSync(await fs.readFile(options.destination)).length);
    assert.deepEqual(data.features[0], {
        type: 'Feature', id: '06-000001', geometry: { type: 'Point', coordinates: [-116.75, 36.25] },
        properties: {
            verified: true, country: 'US', state: 'CA', city: 'TEST CITY', structureType: 'TOWER',
            quantity: 1, heightAglFt: 0, elevationMslFt: -166, lightingCode: 'R', markingCode: 'P',
            horizontalAccuracyCode: '1', verticalAccuracyCode: 'A', faaStudyNumber: '2024AWP00001OE',
            actionCode: 'C', actionDate: '2024-02-29'
        }
    });
    const other = data.features[1];
    assert.equal(other.properties.verified, false);
    assert.equal(other.properties.city, 'O’BRIEN, "ISLAND"');
    assert.equal(other.properties.state, null);
    assert.equal(other.properties.horizontalAccuracyCode, null);
    assert.equal(other.properties.verticalAccuracyCode, null);
    assert.equal(other.properties.faaStudyNumber, null);
    assert.equal(other.properties.lightingCode, 'U');
    assert.equal(other.properties.actionDate, '2024-12-31');
    assert.deepEqual(other.geometry.coordinates, [174.138873, -14.355278]);
});

test('invalid coordinates, identifiers, units, status and action dates fail instead of dropping obstacles', async t => {
    const options = await setup(t);
    for (const [field, value] of [
        ['LATDEC', '91'], ['LATDEC', ''], ['LATDEC', 'NaN'], ['LONDEC', '-181'],
        ['LONDEC', 'Infinity'], ['OAS', 'not-an-id'], ['VERIFIED STATUS', 'X'],
        ['AGL', '-1'], ['AGL', '200ft'], ['AGL', ''], ['AMSL', '1.5'],
        ['QUANTITY', '0'], ['QUANTITY', '10'], ['ACCURACY', '0Z'],
        ['LIGHTING', '?'], ['MARKING', '?'], ['ACTION', 'D'],
        ['JDATE', '2023366'], ['JDATE', '2024000'], ['JDATE', '2024367'], ['JDATE', '20240101']
    ]) {
        await fs.writeFile(options.csvFile, csv(record({ [field]: value })), 'latin1');
        await assert.rejects(writeObstacleGeoJson(options.csvFile, options.destination),
            error => error instanceof Error && error.message.includes(`DOF.CSV line 2: Invalid ${field}`));
    }
});

test('empty/truncated CSV, duplicate identities and changed schemas cannot publish partial data', async t => {
    const options = await setup(t);
    const cases: [string, RegExp][] = [
        ['', /no obstacles/], [csv(), /no obstacles/],
        [csv(record()).replace('LATDEC,', ''), /Missing CSV columns: LATDEC/],
        [csv(record()).replace('DMSLAT,', 'LATDEC,'), /duplicate CSV headers/],
        [csv(record()).replace('DMSLAT,', ','), /Empty or duplicate CSV headers/],
        [csv(`${record()},extra`), /row has 20 fields; expected 19/],
        [csv(record(), columns.map(() => '').join(',')), /line 3: Empty CSV record/],
        [csv(record(), columns.map(() => '""').join(',')), /line 3: Empty CSV record/],
        [csv(record(), record()), /line 3: Duplicate OAS/],
        [csv(record(), '"unterminated'), /line 3: CSV input ends inside a quoted field/]
    ];
    for (const [contents, expected] of cases) {
        await fs.writeFile(options.csvFile, contents, 'latin1');
        await assert.rejects(writeObstacleGeoJson(options.csvFile, options.destination), expected);
    }
});

test('CSV streams across chunk boundaries and exports every record', async t => {
    const options = await setup(t);
    const count = 2000;
    await fs.writeFile(options.csvFile, csv(...Array.from({ length: count }, (_, index) =>
        record({ OAS: `06-${String(index).padStart(6, '0')}`, CITY: 'O\x92BRIEN' }))), 'latin1');
    const stats = await writeObstacleGeoJson(options.csvFile, options.destination);
    const data = await readExport(options.destination);
    assert.equal(stats.count, count);
    assert.equal(data.features.length, count);
    assert.ok(data.features.every(feature => feature.properties.city === 'O’BRIEN'));
    assert.equal(data.features.at(-1).id, '06-001999');
});

test('local ZIP builds publish a complete manifest with matching hashes and no invented source date', async t => {
    const options = await setup(t);
    await archive(options, csv(record()));
    const manifest = await buildObstacles({ ...options, fetch: async () => { throw new Error('Unexpected network'); } });
    const published = path.join(options.output, 'charts', 'obstacles');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(published, 'manifest.json'), 'utf8')), manifest);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.horizontalDatum, 'WGS84');
    assert.equal(manifest.source.sha256, await sha256File(options.sourceFile));
    assert.equal(manifest.source.filename, 'daily.zip');
    assert.equal(manifest.source.lastModified, undefined);
    assert.equal(manifest.source.etag, undefined);
    assert.ok(Number.isFinite(Date.parse(manifest.generatedAt)));
    const file = path.join(published, manifest.dataset.path);
    assert.equal(manifest.dataset.path, `obstacles-${manifest.dataset.sha256}.geojson.gz`);
    assert.equal(manifest.dataset.sha256, await sha256File(file));
    assert.equal(manifest.dataset.bytes, (await fs.stat(file)).size);
    assert.equal(manifest.dataset.uncompressedBytes, gunzipSync(await fs.readFile(file)).length);
    assert.equal(manifest.dataset.count, 1);
    assert.deepEqual(await fs.readdir(published), ['manifest.json', manifest.dataset.path]);
    assert.deepEqual(await fs.readdir(path.join(options.output, 'charts')), ['obstacles']);
    assert.equal((await fs.stat(published)).mode & 0o777, 0o755);
});

test('online builds check freshness, reuse the current ZIP, recover corrupt cache and replace full snapshots', async t => {
    const options = await setup(t);
    let body = await archive(options, csv(record(), record({ OAS: '06-000002' })));
    let etag = '"version-1"';
    let modified = 'Fri, 18 Sep 2026 03:31:59 GMT';
    let gets = 0;
    let heads = 0;
    const fetcher: typeof fetch = async (url, init) => {
        assert.equal(url, DAILY_DOF_URL);
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('cache-control'), 'no-cache');
        if (init?.method === 'HEAD') {
            heads++;
            return new Response(null, { headers: { etag, 'last-modified': modified } });
        }
        gets++;
        assert.equal(headers.get('if-match'), etag);
        return new Response(new Uint8Array(body), { headers: { etag, 'content-length': String(body.length) } });
    };
    const build = () => buildObstacles({ output: options.output, fetch: fetcher });
    const first = await build();
    assert.equal(first.source.lastModified, '2026-09-18T03:31:59.000Z');
    assert.equal(first.source.etag, etag);
    assert.equal(first.dataset.count, 2);
    assert.equal(gets, 1);
    assert.deepEqual((await build()).dataset, first.dataset);
    assert.equal(heads, 2);
    assert.equal(gets, 1);

    const cache = path.join(options.output, 'obstacles');
    const [cached] = await fs.readdir(cache);
    await fs.writeFile(path.join(cache, cached), 'damaged ZIP');
    assert.deepEqual((await build()).dataset, first.dataset);
    assert.equal(gets, 2);

    etag = '"version-2"';
    modified = 'Sat, 19 Sep 2026 03:32:01 GMT';
    body = await archive(options, csv(record({ OAS: '06-000002', AGL: '00125' })));
    const second = await build();
    assert.equal(gets, 3);
    assert.equal(second.dataset.count, 1);
    assert.notEqual(second.dataset.path, first.dataset.path);
    assert.equal(second.source.lastModified, '2026-09-19T03:32:01.000Z');
    assert.deepEqual(await fs.readdir(cache), [`${createHash('sha256').update(etag).digest('hex')}.zip`]);
    const data = await readExport(path.join(options.output, 'charts', 'obstacles', second.dataset.path));
    assert.deepEqual(data.features.map(feature => feature.id), ['06-000002']);
    assert.equal(data.features[0].properties.heightAglFt, 125);
});

test('failed downloads or validation leave the previous publication intact and release the build lock', async t => {
    const options = await setup(t);
    const goodZip = await archive(options, csv(record()));
    const good = await buildObstacles(options);
    const published = path.join(options.output, 'charts', 'obstacles');
    const originalManifest = await fs.readFile(path.join(published, 'manifest.json'));
    const assertUnchanged = async () => {
        assert.deepEqual(await fs.readFile(path.join(published, 'manifest.json')), originalManifest);
        assert.equal(await sha256File(path.join(published, good.dataset.path)), good.dataset.sha256);
        assert.deepEqual(await fs.readdir(path.join(options.output, 'charts')), ['obstacles']);
        await assert.rejects(fs.access(path.join(options.output, 'obstacles.build.lock')), { code: 'ENOENT' });
    };
    for (const contents of [csv(record(), record()), csv(record({ LATDEC: '999' })),
        csv(record(), columns.map(() => '').join(',')), csv()]) {
        await archive(options, contents);
        await assert.rejects(buildObstacles(options), /Duplicate OAS|Invalid LATDEC|Empty CSV record|no obstacles/);
        await assertUnchanged();
    }
    await archive(options, 'wrong entry', 'wrong.csv');
    await assert.rejects(buildObstacles(options), /exactly one DOF.CSV/);
    await assertUnchanged();

    for (const [headers, headStatus, getStatus, expected] of [
        [{ etag: '"a"', 'last-modified': 'Fri, 18 Sep 2026 03:31:59 GMT' }, 503, 200, /source request failed \(503\)/],
        [{ etag: '"a"' }, 200, 200, /ETag\/Last-Modified/],
        [{ etag: 'W/"a"', 'last-modified': 'Fri, 18 Sep 2026 03:31:59 GMT' }, 200, 200, /strong ETag/],
        [{ etag: 'unquoted', 'last-modified': 'Fri, 18 Sep 2026 03:31:59 GMT' }, 200, 200, /strong ETag/],
        [{ etag: '"a"', 'last-modified': 'not a date' }, 200, 200, /ETag\/Last-Modified/],
        [{ etag: '"a"', 'last-modified': 'Fri, 18 Sep 2026 03:31:59 GMT' }, 200, 412, /failed \(412/]
    ] as const) {
        const fetcher: typeof fetch = async (_url, init) => init?.method === 'HEAD'
            ? new Response(null, { status: headStatus, headers })
            : new Response(new Uint8Array(goodZip), { status: getStatus });
        await assert.rejects(buildObstacles({ output: options.output, fetch: fetcher }), expected);
        await assertUnchanged();
    }
});

test('resumed ZIP requests stay pinned to the source ETag', async t => {
    const options = await setup(t);
    const body = await archive(options, csv(record()));
    const etag = '"resume-version"';
    const cache = path.join(options.output, 'obstacles');
    await fs.mkdir(cache, { recursive: true });
    const key = createHash('sha256').update(etag).digest('hex');
    const offset = 50;
    await fs.writeFile(path.join(cache, `${key}.zip.part`), body.subarray(0, offset));
    const fetcher: typeof fetch = async (_url, init) => {
        if (init?.method === 'HEAD') return new Response(null, {
            headers: { etag, 'last-modified': 'Fri, 18 Sep 2026 03:31:59 GMT' }
        });
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('if-match'), etag);
        assert.equal(headers.get('range'), `bytes=${offset}-`);
        return new Response(new Uint8Array(body.subarray(offset)), { status: 206,
            headers: { 'content-range': `bytes ${offset}-${body.length - 1}/${body.length}`,
                'content-length': String(body.length - offset) } });
    };
    assert.equal((await buildObstacles({ output: options.output, fetch: fetcher })).dataset.count, 1);
    assert.deepEqual(await fs.readdir(cache), [`${key}.zip`]);
});

test('online and local builds cannot replace an active builder’s snapshot or cache', { timeout: 5000 }, async t => {
    const options = await setup(t);
    const body = await archive(options, csv(record()));
    let started: () => void;
    let resume: () => void;
    const downloading = new Promise<void>(resolve => { started = resolve; });
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const first = buildObstacles({ output: options.output, fetch: async (_url, init) => {
        if (init?.method === 'HEAD') return new Response(null, {
            headers: { etag: '"version"', 'last-modified': 'Fri, 18 Sep 2026 03:31:59 GMT' }
        });
        started();
        await paused;
        return new Response(new Uint8Array(body));
    } });
    try {
        await Promise.race([downloading, first]);
        const work = await fs.readdir(path.join(options.output, 'charts'));
        await assert.rejects(buildObstacles({ output: options.output,
            fetch: async () => { throw new Error('Competing build must not fetch'); }
        }), /already in progress/);
        await assert.rejects(buildObstacles(options), /already in progress/);
        assert.deepEqual(await fs.readdir(path.join(options.output, 'charts')), work);
    } finally {
        resume();
        await first;
    }
    const manifest = await first;
    const data = await readExport(path.join(options.output, 'charts', 'obstacles', manifest.dataset.path));
    assert.equal(data.features[0].id, original.OAS);
    await assert.rejects(fs.access(path.join(options.output, 'obstacles.build.lock')), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(path.join(options.output, 'charts')), ['obstacles']);
});
