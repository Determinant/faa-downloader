import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { GdalPool } from '../lib/gdal.ts';
import { mergeGlideLandingAreas } from '../lib/glide-areas.ts';
import { mergeGlideLandingAreasIndexed } from '../lib/glide-merge.ts';
import { encodeGlideShards, mergeGlideShardPatches, validateGlideShardPatches } from '../lib/glide-shards.ts';
import { GlideAssembly, glideAssemblyConcurrency } from '../lib/glide-assembly.ts';
import { mapWithConcurrency } from '../lib/concurrency.ts';
import type { GlideLandingArea } from '../lib/glide-model.ts';

const box = (x: number, y: number, size = 10_000, flags = 256): GlideLandingArea =>
    [[x + 1000, y + size / 2, x + size - 1000, y + size / 2, 100, 1500, 123, 1, 17, -9],
        [[x, y, size, 0, 0, size, -size, 0]], flags];

function fixtures(): GlideLandingArea[][] {
    const x = -98_000_000, y = 26_000_000;
    const donut = box(x, y, 40_000);
    donut[1].push([x + 10_000, y + 10_000, 0, 20_000, 20_000, 0, 0, -20_000]);
    donut[0][1] = donut[0][3] = y + 5000;
    const crop = box(x + 5000, y, 10_000, 257), longer = box(x, y);
    longer[0][5] = 2000;
    const tie = structuredClone(longer); tie[0][8] = -17; tie[0][9] = 9;
    const preferred = box(x, y, 10_000, 0);
    preferred[0][4] = 200; preferred[0][5] = 2500; preferred[0][7] = 2;
    // Midpoints on boundaries and at half-microdegrees exercise inclusive,
    // outward-rounded R-tree comparisons rather than just interior points.
    const boundary = box(x, y);
    boundary[0][0] = boundary[0][2] = x;
    const half = box(x + 100_003, y + 100_007);
    half[0][2]++;
    return [
        [], [preferred],
        [crop, longer, tie, box(x + 50_000, y)],
        [donut, box(x + 15_000, y + 15_000, 5000), box(x + 70_000, y)],
        [box(x, y), box(x + 10_000, y), box(x + 20_000, y + 10_000)],
        [preferred, crop, box(x, y, 10_000, 256 | 1024), box(x, y, 10_000, 256 | 2 | 4)],
        [boundary, half, box(x + 70_000, y)],
        Array.from({ length: 32 }, (_, i) => box(x + (i % 8) * 13_037, y + Math.floor(i / 8) * 15_021)),
    ];
}

test('indexed matching preserves exact reference polygons, holes, grades, flags and gzip shards on both GDAL backends', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-merge-equivalence-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    for (const library of [null, undefined]) {
        const pool = await GdalPool.create(1, { library, tools: ['ogr2ogr'] });
        try {
            await pool.run(async () => {
                for (const [i, records] of fixtures().entries()) {
                    const before = structuredClone(records);
                    const expected = await mergeGlideLandingAreas(records, directory);
                    const actual = await mergeGlideLandingAreasIndexed(records, directory);
                    assert.deepEqual(actual, expected, `fixture ${i}, ${pool.library ? 'native' : 'CLI'}`);
                    assert.deepEqual(await encodeGlideShards(`fixture-${i}`, actual, records),
                        await encodeGlideShards(`fixture-${i}`, expected, records), 'same bytes, bounds, counts and shard IDs');
                    assert.deepEqual(records, before, 'prepared records are never mutated');
                }
            });
        } finally { await pool.close(); }
    }
    assert.deepEqual(await fs.readdir(directory), []);
});

test('assembly concurrency is independent of preparation and keeps identical artifacts and reusable receipts', async t => {
    assert.equal(glideAssemblyConcurrency(undefined, 1), 1);
    assert.equal(glideAssemblyConcurrency(undefined, 16), 4);
    assert.equal(glideAssemblyConcurrency(8, 1), 8);
    for (const value of [0, -1, 1.5, 17, NaN]) assert.throws(() => glideAssemblyConcurrency(value), /--assembly-concurrency/);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-assembly-concurrency-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const groups = await Promise.all(Array.from({ length: 8 }, async (_, i) => {
        const records = [box(-98_000_000 + i * 100_000, 26_000_000), box(-97_995_000 + i * 100_000, 26_000_000)];
        const text = records.map(record => JSON.stringify(record)).join('\n') + '\n';
        const file = path.join(directory, `group-${i}.jsonl`);
        await fs.writeFile(file, text);
        return { id: `group-${i}`, spools: [{ file, sha256: createHash('sha256').update(text).digest('hex') }] };
    }));
    const inputs = { implementation: 'unchanged', versions: ['same GDAL'] };
    const assemble = async (concurrency: number, cache: string) => {
        const pool = await GdalPool.create(concurrency, { tools: ['ogr2ogr'] });
        try {
            return await pool.run(() => mapWithConcurrency(groups, concurrency, group =>
                new GlideAssembly(cache, directory, inputs).assemble(group.id, group.spools)));
        } finally { await pool.close(); }
    };
    const serial = await assemble(1, path.join(directory, 'serial'));
    const concurrent = await assemble(8, path.join(directory, 'parallel'));
    assert.deepEqual(concurrent.map(r => r.shards), serial.map(r => r.shards));
    const resumed = await assemble(8, path.join(directory, 'serial'));
    assert.ok(resumed.every(r => r.reusedGroup), 'a scheduling change does not repeat completed merges or encoding');
    assert.deepEqual(resumed.map(r => r.shards), serial.map(r => r.shards));
});

test('a valid-looking union cannot silently omit disconnected components without qualifications', async t => {
    const { originals }: { originals: GlideLandingArea[] } = JSON.parse(await fs.readFile(
        new URL('fixtures/glide-unqualified-union.json', import.meta.url), 'utf8'));
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-unqualified-union-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const before = structuredClone(originals);
    for (const library of [null, undefined]) {
        const pool = await GdalPool.create(1, { library, tools: ['ogr2ogr'] });
        try {
            await pool.run(async () => {
                // The old inner join dropped the extra components. Checking
                // only the surviving polygons' validity cannot detect that loss.
                const incomplete = await mergeGlideLandingAreas(originals, directory);
                await validateGlideShardPatches(incomplete);
                await assert.rejects(mergeGlideLandingAreasIndexed(originals, directory), /component without a qualification/);
                const logs: string[] = [];
                const recovered = await mergeGlideShardPatches(originals, directory, message => logs.push(message));
                await validateGlideShardPatches(recovered);
                assert.ok(logs.some(message => message.includes('geometry cleanup')));
                assert.notDeepEqual(recovered, incomplete, 'invalid input is recovered before the union, not silently omitted by its join');
                assert.deepEqual(recovered.map(area => area[0]).sort(), originals.map(area => area[0]).sort());
            });
        } finally { await pool.close(); }
    }
    assert.deepEqual(originals, before);
});
