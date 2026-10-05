import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { GdalPool } from '../lib/gdal.ts';
import { recoverGlidePrecision } from '../lib/glide-precision.ts';
import { prepareGlideShardPatches, validateGlideShardPatches } from '../lib/glide-shards.ts';
import type { GlideLandingArea } from '../lib/glide-model.ts';

const ring = (points: number[][]) => {
    let x = 0, y = 0;
    return points.flatMap(([nx, ny]) => { const pair = [nx - x, ny - y]; x = nx; y = ny; return pair; });
};
function notchedField(): GlideLandingArea {
    const x = -98_000_000, y = 26_000_000;
    const points = [[0, 0], [4000, 0], [4000, 1000], [2000, 1000], [2001, 999], [2000, 999], [2001, 1000], [0, 1000]];
    return [[x + 500, y + 500, x + 3500, y + 500, 60, 980, 100, 1, 0, 0],
        [ring(points.map(([dx, dy]) => [x + dx, y + dy]))], 256];
}

test('precision recovery preserves the complete fit, grades and flags on real saved data across GDAL backends', async () => {
    const { originals }: { originals: GlideLandingArea[] } = JSON.parse(await fs.readFile(
        new URL('fixtures/glide-unqualified-union.json', import.meta.url), 'utf8'));
    const before = structuredClone(originals);
    let expected: GlideLandingArea[] | undefined;
    for (const library of [null, undefined]) {
        const pool = await GdalPool.create(1, { library, tools: ['ogr2ogr'] });
        try {
            await pool.run(async () => {
                const messages: string[] = [];
                const prepared = await prepareGlideShardPatches(originals, message => messages.push(message));
                await validateGlideShardPatches(prepared);
                assert.deepEqual(prepared.map(a => [a[0], a[2]]), originals.map(a => [a[0], a[2]]));
                assert.equal(prepared[0], originals[0], 'valid geometry is retained byte for byte');
                assert.notDeepEqual(prepared[1][1], originals[1][1]);
                assert.match(messages[0], /geometry cleanup.*full fit and exclusions retained/);
                assert.equal(messages.length, 1);
                if (expected) assert.deepEqual(prepared, expected);
                expected = prepared;
            });
        } finally { await pool.close(); }
    }
    assert.deepEqual(originals, before);
});

test('full-width containment rejects an exclusion crossing the fit even when its midpoint and centerline are clear', async () => {
    const pool = await GdalPool.create(1, { tools: ['ogr2ogr'] });
    try {
        await pool.run(async () => {
            const original = notchedField();
            await assert.rejects(validateGlideShardPatches([original]), /Self-intersection/);
            const recovered = await recoverGlidePrecision(original);
            assert.ok(recovered);
            assert.ok(recovered.removedFraction > 0 && recovered.removedFraction < 0.02);
            await validateGlideShardPatches([recovered.area]);
            // This hole sits 5.5 m from the centerline, within the 60 ft width.
            // It contains neither endpoint nor the qualification midpoint.
            const blocked = structuredClone(original);
            blocked[1].push(ring([[-97_998_500, 26_000_550], [-97_998_400, 26_000_550],
                [-97_998_400, 26_000_650], [-97_998_500, 26_000_650]]));
            assert.equal(await recoverGlidePrecision(blocked), undefined);
            const messages: string[] = [];
            assert.deepEqual(await prepareGlideShardPatches([blocked], message => messages.push(message)), []);
            assert.match(messages[0], /omitted invalid patch.*no valid connected piece retains the full fit/);
        });
    } finally { await pool.close(); }
});

test('a fit spanning disconnected lobes cannot be attached to either fragment', async () => {
    const area = notchedField(), x = -98_000_000, y = 26_000_000;
    area[1] = [ring([[x, y], [x + 4000, y + 1000], [x + 4000, y], [x, y + 1000]])];
    const pool = await GdalPool.create(1, { tools: ['ogr2ogr'] });
    try { await pool.run(async () => {
        assert.equal(await recoverGlidePrecision(area), undefined);
        assert.deepEqual(await prepareGlideShardPatches([area]), []);
    }); } finally { await pool.close(); }
});

test('cleanup retains the qualified component even when a large disconnected lobe must be removed', async () => {
    const { record }: { record: GlideLandingArea } = JSON.parse(await fs.readFile(
        new URL('fixtures/glide-disconnected-cleanup.json', import.meta.url), 'utf8'));
    const before = structuredClone(record);
    let expected: GlideLandingArea | undefined;
    for (const library of [null, undefined]) {
        const pool = await GdalPool.create(1, { library, tools: ['ogr2ogr'] });
        try { await pool.run(async () => {
            const cleaned = await recoverGlidePrecision(record);
            assert.ok(cleaned);
            assert.ok(cleaned.removedFraction > 0.86 && cleaned.removedFraction < 0.88);
            assert.equal(cleaned.area[0], record[0]);
            assert.equal(cleaned.area[2], record[2]);
            await validateGlideShardPatches([cleaned.area]);
            const prepared = await prepareGlideShardPatches([record]);
            assert.deepEqual(prepared, [cleaned.area]);
            if (expected) assert.deepEqual(cleaned.area, expected);
            expected = cleaned.area;
        }); } finally { await pool.close(); }
    }
    assert.deepEqual(record, before, 'saved geometry remains unchanged');
});
