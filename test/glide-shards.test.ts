import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { glideAreaBounds, mergeGlideLandingAreas } from '../lib/glide-areas.ts';
import { gdalCli, GdalPool } from '../lib/gdal.ts';
import { encodeGlideShards, readGlidePatchBatches, mergeGlideShardPatches, validateGlideShardPatches, type EncodedGlideShard } from '../lib/glide-shards.ts';
import type { GlideLandingArea } from '../lib/glide-model.ts';

const area = (i: number): GlideLandingArea => {
    const x = -98_000_000 + i * 3_037, y = 26_000_000 + (i % 7) * 5_021;
    return [[x, y, x + 2_000, y, 60, 600, 123, 1], [[x - 100, y - 100, 2_200, 0, 0, 200, -2_200, 0]], 256];
};
const decode = (shard: EncodedGlideShard): GlideLandingArea[] => JSON.parse(gunzipSync(shard.data).toString());
const canonical = (records: GlideLandingArea[]) => records.map(record => JSON.stringify(record)).sort();

test('streamed merge batches preserve every record in file order and bound bytes/count', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-shards-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const records = Array.from({ length: 50 }, (_, i) => area(i));
    const files = [path.join(directory, 'a'), path.join(directory, 'empty'), path.join(directory, 'b')];
    await fs.writeFile(files[0], records.slice(0, 7).map(record => JSON.stringify(record)).join('\n') + '\n');
    await fs.writeFile(files[1], '\n');
    await fs.writeFile(files[2], records.slice(7).map(record => JSON.stringify(record)).join('\n') + '\n');
    const batches: GlideLandingArea[][] = [];
    for await (const batch of readGlidePatchBatches(files, 900, 4)) batches.push(batch);
    assert.deepEqual(batches.flat(), records);
    assert.ok(batches.length > 2);
    for (const batch of batches) {
        assert.ok(batch.length <= 4);
        assert.ok(Buffer.byteLength(JSON.stringify(batch) + '\n') <= 900);
    }
});

test('raw, compressed and record limits split spatially without altering or dropping polygons', async () => {
    const records = Array.from({ length: 80 }, (_, i) => area(i)), before = structuredClone(records);
    const compressedBytes = gzipSync(JSON.stringify(records) + '\n', { level: 9 }).length;
    for (const limits of [
        { maxRawBytes: 1_500, maxBytes: 1_000_000, maxRecords: 100_000 },
        { maxRawBytes: 1_000_000, maxBytes: Math.floor(compressedBytes / 3), maxRecords: 100_000 },
        { maxRawBytes: 1_000_000, maxBytes: 1_000_000, maxRecords: 9 },
    ]) {
        const shards = await encodeGlideShards('dense', records, undefined, limits);
        assert.ok(shards.length > 1);
        assert.equal(new Set(shards.map(shard => shard.id)).size, shards.length);
        assert.deepEqual(canonical(shards.flatMap(decode)), canonical(records));
        for (const shard of shards) {
            const decoded = decode(shard);
            assert.ok(shard.rawBytes <= limits.maxRawBytes);
            assert.ok(shard.data.length <= limits.maxBytes);
            assert.ok(shard.count <= limits.maxRecords);
            assert.equal(shard.rawBytes, gunzipSync(shard.data).length);
            assert.equal(shard.count, decoded.length);
            assert.deepEqual(shard.tiers, [decoded.length, 0]);
            assert.deepEqual(shard.bounds, glideAreaBounds(decoded));
        }
        assert.deepEqual(await encodeGlideShards('dense', records, undefined, limits), shards, 'deterministic bytes and IDs');
    }
    assert.deepEqual(records, before, 'caller geometry/order are unchanged');
});

test('coincident midpoints still split; oversized unions fall back to qualified original patches', async () => {
    const records = Array.from({ length: 10 }, () => area(0));
    assert.equal((await encodeGlideShards('same', records, undefined,
        { maxRawBytes: 1_000_000, maxBytes: 1_000_000, maxRecords: 1 })).length, 10);
    const merged = area(0);
    merged[1][0].push(...Array.from({ length: 2_000 }, (_, i) => i));
    const limits = { maxRawBytes: 1_000, maxBytes: 1_000_000, maxRecords: 100_000 };
    const shards = await encodeGlideShards('union', [merged], records, limits);
    assert.deepEqual(canonical(shards.flatMap(decode)), canonical(records));
    await assert.rejects(encodeGlideShards('union', [merged], undefined, limits), /cannot split its polygon without requalification/);
    assert.deepEqual(await encodeGlideShards('empty', []), []);
});

test('union rounding cannot erase a tiny exclusion or abort delivery of the original qualified patches', async t => {
    try { await gdalCli('ogr2ogr', ['--version']); }
    catch { t.skip('Requires GDAL and GEOS'); return; }
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-shards-ring-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const rectangle = (a: number[], b: number[], d: number[]) => [a, b,
        [b[0] + d[0], b[1] + d[1]], [a[0] + d[0], a[1] + d[1]]];
    // Four integer-coordinate strips surround a sub-microdegree hole at their
    // intersections. The original polygons are representable; the union is not.
    const rings = [rectangle([-100, 1], [100, -1], [-100, -10000]),
        rectangle([-99, 1], [101, -1], [100, 10000]),
        rectangle([-1, -100], [1, 100], [-10000, 100]),
        rectangle([-1, -101], [1, 99], [10000, -100])];
    const records: GlideLandingArea[] = rings.map(ring => {
        const points = ring.map(([x, y]) => [x - 98_000_000, y + 26_000_000]);
        let x = 0, y = 0;
        const encoded = points.flatMap(([nx, ny]) => { const delta = [nx - x, ny - y]; x = nx; y = ny; return delta; });
        const cx = Math.round(points.reduce((sum, p) => sum + p[0], 0) / 4);
        const cy = Math.round(points.reduce((sum, p) => sum + p[1], 0) / 4);
        return [[cx - 1000, cy, cx + 1000, cy, 60, 600, 100, 1], [encoded], 256];
    });
    const pool = await GdalPool.create(1, { tools: ['ogr2ogr'] });
    try {
        await pool.run(async () => {
            await assert.rejects(mergeGlideLandingAreas(records, directory), /collapsed during quantization/);
            const messages: string[] = [];
            const retained = await mergeGlideShardPatches(records, directory, message => messages.push(message));
            assert.deepEqual(canonical(retained), canonical(records));
            assert.equal(messages.length, 1);
            assert.deepEqual(canonical((await encodeGlideShards('rounding', retained)).flatMap(decode)), canonical(records));
            await assert.rejects(mergeGlideShardPatches(records, path.join(directory, 'absent')), { code: 'ENOENT' });
        });
    } finally { await pool.close(); }
});

test('a null union cannot republish invalid originals on either GDAL backend', async t => {
    try { await gdalCli('ogr2ogr', ['--version']); }
    catch { t.skip('Requires GDAL and GEOS'); return; }
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-shards-null-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const records = [area(0), area(1), area(2)];
    records[0][2] = 0; // This quality group succeeds before the failing union.
    records[2][2] |= 1;
    const [x, y] = records[1][0];
    // A self-intersection, possible after coordinate quantization, makes
    // ST_Union return NULL without ogr2ogr rejecting the command.
    records[1][1] = [[x - 100, y - 100, 2_200, 200, 0, -200, -2_200, 200]];
    const before = structuredClone(records);
    for (const library of [null, undefined]) {
        const pool = await GdalPool.create(1, { library, tools: ['ogr2ogr'] });
        try {
            await pool.run(async () => {
                await assert.rejects(mergeGlideLandingAreas(records, directory),
                    { name: 'TypeError', message: "Cannot read properties of null (reading 'type')" });
                const messages: string[] = [];
                const cleaned = await mergeGlideShardPatches(records, directory, message => messages.push(message));
                assert.deepEqual(canonical(cleaned), canonical([records[0], records[2]]));
                await validateGlideShardPatches(cleaned);
                assert.deepEqual(records, before, 'the original boundaries, qualifications and flags are unchanged');
                assert.equal(messages.length, 1);
                assert.match(messages[0], /geometry cleanup omitted invalid patch/);
                await assert.rejects(encodeGlideShards('null', records), /Invalid quantized glide polygon/);
                assert.deepEqual(await fs.readdir(directory), [], 'failed merge work is cleaned up');
            });
        } finally { await pool.close(); }
    }
});

test('delivery rejects collinear rings, nonzero-area crossings and misplaced holes even without a union', async t => {
    const pool = await GdalPool.create(1, { tools: ['ogr2ogr'] });
    t.after(() => pool.close());
    await pool.run(async () => {
        const collinear = area(0), crossing = area(0), hole = area(0);
        collinear[1] = [[-98_000_000, 26_000_000, 100, 0, 100, 0]];
        crossing[1] = [[-98_000_000, 26_000_000, 200, 200, 0, -200, -100, 200]];
        hole[1].push([-97_000_000, 26_000_000, 100, 0, 0, 100, -100, 0]);
        for (const invalid of [collinear, crossing, hole]) {
            await assert.rejects(encodeGlideShards('invalid', [invalid, area(1)]), /Invalid quantized glide polygon/);
            const originals = [area(0), area(1)];
            const recovered = await encodeGlideShards('rounded-union', [invalid], originals);
            assert.deepEqual(recovered.flatMap(decode), [originals[0]], 'only originals overlapping the failed union are needed');
        }
        const invalidOriginal = [collinear];
        assert.deepEqual(await encodeGlideShards('invalid-fallback', [crossing], invalidOriginal), []);
    });
});

test('real quantized batch retains valid unions when an unrelated original is invalid, on both GDAL backends', async t => {
    const { merged, originals }: { merged: GlideLandingArea[]; originals: GlideLandingArea[] } =
        JSON.parse(await fs.readFile(new URL('fixtures/glide-quantization-fallback.json', import.meta.url), 'utf8'));
    const before = structuredClone({ merged, originals });
    const badOriginal = originals.find(record => record[0][0] === -99596265)!;
    const expected = [merged[2], ...originals.filter(record => record !== badOriginal)];
    let previous: EncodedGlideShard[] | undefined;
    for (const library of [null, undefined]) {
        const pool = await GdalPool.create(1, { library, tools: ['ogr2ogr'] });
        try {
            await pool.run(async () => {
                await assert.rejects(validateGlideShardPatches(merged), /4 invalid patches/);
                await assert.rejects(validateGlideShardPatches(originals), /Self-intersection/);
                const messages: string[] = [];
                const shards = await encodeGlideShards('quantized', merged, originals, undefined, message => messages.push(message));
                assert.deepEqual(shards.flatMap(decode), expected, 'whole polygons, holes, full fits and flags survive unchanged');
                assert.match(messages[0], /retained 1 merged polygons; replaced 4 .* with 11 validated original patches/);
                await validateGlideShardPatches(shards.flatMap(decode));
                if (previous) assert.deepEqual(shards, previous, 'CLI and native output bytes match');
                previous = shards;
            });
        } finally { await pool.close(); }
    }
    assert.deepEqual({ merged, originals }, before);
});

test('local fallback includes whole contributors outside the witness bounds and isolates quality', async () => {
    const original = area(0), bad = structuredClone(original), unrelated = area(3);
    // Both failed union pieces need the same original, whose fit lies outside
    // these narrow bounds. Selecting by fit midpoint would drop its ground.
    const [x, y] = original[0];
    bad[1] = [[x - 100, y - 100, 50, 200, 0, -200, -50, 200]];
    const differentQuality = structuredClone(bad); differentQuality[2] |= 2;
    const shards = await encodeGlideShards('local', [bad, structuredClone(bad), unrelated], [original, differentQuality]);
    assert.deepEqual(shards.flatMap(decode), [unrelated, original], 'one exact original replaces both bad pieces');
    await assert.rejects(encodeGlideShards('unmatched', [bad], [differentQuality]), /Invalid quantized glide polygon/);
    await assert.rejects(encodeGlideShards('unmatched', [bad], [area(20)]), /Invalid quantized glide polygon/);
});

test('a real collapsed union keeps unrelated successful unions instead of reviving invalid originals', async t => {
    const { originals }: { originals: GlideLandingArea[] } =
        JSON.parse(await fs.readFile(new URL('fixtures/glide-collapsed-union-fallback.json', import.meta.url), 'utf8'));
    const before = structuredClone(originals), directory = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-collapsed-union-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const collapsedFits = new Set([-99749648, -99750011, -99749551]);
    let previous: EncodedGlideShard[] | undefined;
    for (const library of [null, undefined]) {
        const pool = await GdalPool.create(1, { library, tools: ['ogr2ogr'] });
        try {
            await pool.run(async () => {
                await assert.rejects(mergeGlideLandingAreas(originals, directory), /collapsed during quantization/);
                await assert.rejects(validateGlideShardPatches(originals), /Self-intersection/);
                const messages: string[] = [];
                const merged = await mergeGlideShardPatches(originals, directory, message => messages.push(message));
                assert.ok(messages.some(message => /ring below coordinate precision; retaining 3 validated original patches for the affected polygon/.test(message)));
                const shards = await encodeGlideShards('collapsed', merged, originals);
                const delivered = shards.flatMap(decode);
                assert.deepEqual(canonical(delivered.filter(r => collapsedFits.has(r[0][0]))),
                    canonical(originals.filter(r => collapsedFits.has(r[0][0]))), 'collapsed union retains all exact contributing patches');
                assert.deepEqual(delivered.map(r => r[0]).sort(), originals.map(r => r[0]).sort(), 'every qualification survives');
                await validateGlideShardPatches(delivered);
                if (previous) assert.deepEqual(shards, previous);
                previous = shards;
            });
        } finally { await pool.close(); }
    }
    assert.deepEqual(originals, before);
    assert.deepEqual(await fs.readdir(directory), []);
});

test('oversized fallback also retains unrelated valid unions and refuses an oversized original', async () => {
    const union = area(0), original = area(0), valid = area(10), invalidOriginal = structuredClone(valid);
    // Add redundant vertices along a straight edge, making one valid union too large.
    union[1][0].splice(4, 0, ...Array.from({ length: 300 }, () => [0, 0]).flat());
    const [x, y] = valid[0];
    invalidOriginal[1] = [[x - 100, y - 100, 2200, 200, 0, -200, -2200, 200]];
    const limits = { maxRawBytes: 1000, maxBytes: 1_000_000, maxRecords: 100_000 };
    const recovered = await encodeGlideShards('large', [union, valid], [original, invalidOriginal], limits);
    assert.deepEqual(canonical(recovered.flatMap(decode)), canonical([valid, original]));
    await assert.rejects(encodeGlideShards('large-original', [union], [structuredClone(union)], limits),
        /cannot split its polygon without requalification/);
});

test('union fallback does not hide unrelated GDAL, input or programming failures', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-shards-failure-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const pool = await GdalPool.create(1, { library: null, version: 'test' });
    t.after(() => pool.close());
    const records = [area(0), area(1)], messages: string[] = [];
    for (const failure of [new Error('ogr2ogr failed: disk full'),
        new TypeError("Cannot read properties of null (reading 'type')")]) {
        const command = t.mock.method(pool, 'command', async () => { throw failure; });
        try {
            await pool.run(() => assert.rejects(
                mergeGlideShardPatches(records, directory, message => messages.push(message)), error => error === failure));
        } finally { command.mock.restore(); }
    }
    const malformed = structuredClone(records);
    malformed[0][1] = null!;
    await assert.rejects(mergeGlideShardPatches(malformed, directory, message => messages.push(message)), TypeError);
    assert.deepEqual(messages, []);
});
