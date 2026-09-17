import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync, zstdCompressSync } from 'node:zlib';
import { sha256File } from '../lib/fs-utils.ts';
import { buildRouteHistory, readRouteHistory, ROUTE_HISTORY_URL } from '../lib/route-history.ts';

const fixture = await fs.readFile(new URL('./fixtures/route-history.sql', import.meta.url), 'utf8');
async function setup(t: { after: (fn: () => Promise<void>) => void }) {
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-route-history-'));
    t.after(() => fs.rm(outputRoot, { recursive: true, force: true }));
    const sourceFile = path.join(outputRoot, 'routes.sqlite');
    const db = new DatabaseSync(sourceFile);
    db.exec(fixture);
    db.close();
    return { outputRoot, sourceFile, effectiveDate: '2026-09-03',
        destination: path.join(outputRoot, 'nav', 'route-history.json.gz') };
}
const readExport = async (file: string) => JSON.parse(gunzipSync(await fs.readFile(file)).toString());

test('filed history combines engine counts, preserves both directions and dates, and excludes preferred/unused routes', async t => {
    const options = await setup(t);
    const before = await sha256File(options.sourceFile);
    const history = readRouteHistory(options.sourceFile);
    assert.equal(await sha256File(options.sourceFile), before);
    assert.deepEqual(history.observationRange, { firstSeen: '2025-03-25', lastSeen: '2026-01-25' });
    assert.equal(history.routeCount, 4);
    assert.equal(history.pairs.length, 2);
    assert.deepEqual(history.pairs[0], {
        origin: 'KSBA', destination: 'KSMO', totalCount: 144,
        routes: [
            { route: 'KSBA KSMO', count: 114, engineCounts: { Piston: 75, Unknown: 39 }, firstSeen: '2025-05-08', lastSeen: '2026-01-25' },
            { route: 'KSBA SBAP12 KSMO', count: 19, engineCounts: { Piston: 19 }, firstSeen: '2025-08-08', lastSeen: '2025-12-21' },
            { route: 'KSBA KWANG CMA VNY V186 DARTS KSMO', count: 11, engineCounts: { Jet: 11 }, firstSeen: '2025-03-25', lastSeen: '2026-01-20' }
        ]
    });
    assert.equal(history.pairs[1].origin, 'KSMO');
    assert.equal(history.pairs[1].totalCount, 2);
    assert.deepEqual(history.pairs[1].routes[0].engineCounts, { Unknown: 2 });
    assert.ok(!JSON.stringify(history).includes('route_json'));
});

test('malformed counts, dates, empty data, and incompatible source schemas fail the export', async t => {
    const options = await setup(t);
    for (const [sql, expected] of [
        ["UPDATE sfdps_routes_by_type SET use_count=-1 WHERE route_type='f'", /invalid filed records/],
        ["UPDATE sfdps_routes_by_type SET first_seen='bad-date' WHERE route_type='f'", /invalid filed records/],
        ["UPDATE sfdps_routes_by_type SET first_seen='2026-02-01' WHERE route_type='f'", /invalid filed records/],
        ["UPDATE sfdps_routes_by_type SET destination='' WHERE route_type='f'", /invalid filed records/],
        ["DELETE FROM sfdps_routes_by_type WHERE route_type='f'", /no filed routes/],
        ["ALTER TABLE sfdps_routes_by_type RENAME TO changed_schema", /no such table/]
    ] as const) {
        const db = new DatabaseSync(options.sourceFile);
        db.exec(sql);
        db.close();
        assert.throws(() => readRouteHistory(options.sourceFile), expected);
        await fs.rm(options.sourceFile);
        const reset = new DatabaseSync(options.sourceFile);
        reset.exec(fixture);
        reset.close();
    }
});

test('local SQLite and zstd inputs produce gzip exports with provenance, actual observation dates, and matching byte counts', async t => {
    const options = await setup(t);
    const sourceHash = await sha256File(options.sourceFile);
    for (const compressed of [false, true]) {
        const sourceFile = compressed ? `${options.sourceFile}.zst` : options.sourceFile;
        if (compressed) await fs.writeFile(sourceFile, zstdCompressSync(await fs.readFile(options.sourceFile)));
        const result = await buildRouteHistory({ ...options, sourceFile, offline: true,
            fetch: async () => { throw new Error('Local builds must not fetch'); } });
        const bytes = await fs.readFile(options.destination);
        const document = await readExport(options.destination);
        assert.equal(result.bytes, bytes.length);
        assert.equal(result.uncompressedBytes, gunzipSync(bytes).length);
        assert.equal(result.count, 2);
        assert.equal(result.routeCount, 4);
        assert.equal(result.source.sha256, sourceHash);
        assert.equal(document.type, 'ZLayerRouteHistory');
        assert.equal(document.version, 1);
        assert.equal(document.effectiveDate, '2026-09-03');
        assert.equal(document.countBasis, 'source-filed-route-use-count');
        assert.deepEqual(document.observationRange, { firstSeen: '2025-03-25', lastSeen: '2026-01-25' });
        assert.equal(document.window, undefined);
        assert.equal(document.source.lastModified, undefined);
    }
});

test('source ETag caches the download, refreshes changed versions, and rejects failures without overwriting the export', async t => {
    const options = await setup(t);
    let body = zstdCompressSync(await fs.readFile(options.sourceFile));
    let etag = '"first-version"';
    let headStatus = 200;
    let gets = 0;
    let invalidBody = false;
    const fetcher: typeof fetch = async (url, init) => {
        assert.equal(url, ROUTE_HISTORY_URL);
        if (init?.method === 'HEAD') return new Response(null, { status: headStatus,
            headers: { etag, 'last-modified': 'Fri, 13 Feb 2026 21:38:12 GMT' } });
        gets++;
        assert.equal(new Headers(init?.headers).get('if-match'), etag);
        return new Response(new Uint8Array(invalidBody ? zstdCompressSync(Buffer.from('bad SQLite')) : body));
    };
    const build = () => buildRouteHistory({ ...options, sourceFile: undefined, fetch: fetcher });
    await build();
    assert.equal(gets, 1);
    await build();
    assert.equal(gets, 1);
    const cache = path.join(options.outputRoot, 'route-history');
    const [cachedFile] = await fs.readdir(cache);
    await fs.writeFile(path.join(cache, cachedFile), zstdCompressSync(Buffer.from('corrupt cached SQLite')));
    await build();
    assert.equal(gets, 2, 'invalid cached databases are replaced in the same build');
    assert.equal((await readExport(options.destination)).pairs[0].totalCount, 144);

    const updated = new DatabaseSync(options.sourceFile);
    updated.exec("UPDATE sfdps_routes_by_type SET use_count=76 WHERE use_count=75");
    updated.close();
    body = zstdCompressSync(await fs.readFile(options.sourceFile));
    etag = '"second-version"';
    await build();
    assert.equal(gets, 3);
    assert.equal((await fs.readdir(path.join(options.outputRoot, 'route-history'))).length, 1);
    const document = await readExport(options.destination);
    assert.equal(document.pairs[0].totalCount, 145);
    assert.equal(document.pairs[0].routes[0].engineCounts.Piston, 76);
    assert.equal(document.source.etag, etag);
    assert.equal(document.source.lastModified, '2026-02-13T21:38:12.000Z');
    const previous = await fs.readFile(options.destination);
    headStatus = 503;
    await assert.rejects(build(), /source request failed \(503\)/);
    assert.deepEqual(await fs.readFile(options.destination), previous);
    headStatus = 200;
    etag = '"bad-version"';
    invalidBody = true;
    await assert.rejects(build(), /not a database/);
    assert.deepEqual(await fs.readFile(options.destination), previous);
    assert.equal((await fs.readdir(path.join(options.outputRoot, 'route-history'))).length, 1);
    assert.ok(!(await fs.readdir(options.outputRoot)).some(name => name.startsWith('.route-history-')));
});

test('local NASR builds without an explicit history source stay offline', async t => {
    const options = await setup(t);
    assert.equal(await buildRouteHistory({ ...options, sourceFile: undefined, offline: true,
        fetch: async () => { throw new Error('Unexpected fetch'); } }), undefined);
    await assert.rejects(fs.access(options.destination), { code: 'ENOENT' });
});

test('history resumes the current version and only prunes obsolete partials after a successful export', async t => {
    const options = await setup(t);
    const body = zstdCompressSync(await fs.readFile(options.sourceFile));
    const etag = '"current-version"';
    const current = `${createHash('sha256').update(etag).digest('hex')}.sqlite.zst`;
    const obsolete = `${'0'.repeat(64)}.sqlite.zst.part`;
    const cache = path.join(options.outputRoot, 'route-history');
    await fs.mkdir(cache);
    const prefix = body.subarray(0, 20);
    await fs.writeFile(path.join(cache, `${current}.part`), prefix);
    await fs.writeFile(path.join(cache, obsolete), 'obsolete interrupted download');
    await fs.writeFile(path.join(cache, 'notes.txt'), 'unrelated file');
    let fail = true;
    const fetcher: typeof fetch = async (_url, init) => {
        if (init?.method === 'HEAD') return new Response(null, {
            headers: { etag, 'last-modified': 'Fri, 13 Feb 2026 21:38:12 GMT' }
        });
        assert.equal(new Headers(init?.headers).get('if-match'), etag);
        assert.equal(new Headers(init?.headers).get('range'), 'bytes=20-');
        return fail ? new Response(null, { status: 412 }) : new Response(new Uint8Array(body.subarray(20)), {
            status: 206, headers: { 'content-range': `bytes 20-${body.length - 1}/${body.length}` }
        });
    };
    const build = () => buildRouteHistory({ ...options, sourceFile: undefined, fetch: fetcher });
    await assert.rejects(build(), /412/);
    assert.deepEqual(await fs.readFile(path.join(cache, `${current}.part`)), prefix);
    await fs.access(path.join(cache, obsolete));
    fail = false;
    await build();
    assert.deepEqual((await fs.readdir(cache)).sort(), [current, 'notes.txt'].sort());
    assert.equal(await fs.readFile(path.join(cache, 'notes.txt'), 'utf8'), 'unrelated file');
    assert.equal((await readExport(options.destination)).pairs[0].totalCount, 144);
});

test('history cache locking prevents a competing build from touching an active download', { timeout: 5000 }, async t => {
    const options = await setup(t);
    const body = zstdCompressSync(await fs.readFile(options.sourceFile));
    let started: () => void;
    let resume: () => void;
    const downloading = new Promise<void>(resolve => { started = resolve; });
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const first = buildRouteHistory({ ...options, sourceFile: undefined, fetch: async (_url, init) => {
        if (init?.method === 'HEAD') return new Response(null, {
            headers: { etag: '"version"', 'last-modified': 'Fri, 13 Feb 2026 21:38:12 GMT' }
        });
        started();
        await paused;
        return new Response(new Uint8Array(body));
    } });
    try {
        await Promise.race([downloading, first]);
        await assert.rejects(buildRouteHistory({ ...options, sourceFile: undefined,
            fetch: async () => { throw new Error('Competing build must not fetch'); }
        }), /already in progress/);
    } finally {
        resume();
        await first;
    }
    assert.equal((await readExport(options.destination)).pairs[0].totalCount, 144);
    await fs.access(path.join(options.outputRoot, 'route-history'));
    await assert.rejects(fs.access(path.join(options.outputRoot, 'route-history.build.lock')), { code: 'ENOENT' });
});
