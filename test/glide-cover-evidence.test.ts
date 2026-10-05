import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileGlideCover } from '../lib/glide-raster.ts';

const mask = (value: number) => new Uint8Array([value]);
function evidence() {
    return { land: mask(7), canopy: mask(2), impervious: mask(3), mappedRequired: mask(0), disputed: mask(1),
        ground: { open: mask(1), blocked: mask(0) }, fine: mask(2), excluded: mask(0),
        trees: mask(0), water: mask(0), newerOpenEvidence: false };
}
function screen(input: ReturnType<typeof evidence>, eligible = 1) {
    const cover = mask(eligible), uncertainty = reconcileGlideCover(cover, input);
    return [cover[0], uncertainty[0]];
}

test('coarse forest disagreements need independent mapped and fine openings plus low canopy and impervious', () => {
    assert.deepEqual(screen(evidence()), [1, 1]);
    for (const change of [ { canopy: mask(1) }, { impervious: mask(1) }, { fine: mask(0) },
        { ground: { open: mask(0), blocked: mask(0) } }, { ground: { open: mask(1), blocked: mask(1) } },
        { excluded: mask(1) } ]) assert.deepEqual(screen({ ...evidence(), ...change }), [0, 0]);
    assert.deepEqual(screen(evidence(), 0), [0, 0], 'no positive evidence can fill missing required pixels');
});

test('older tree classification yields only to newer corroboration and never overrides water', () => {
    const input = { ...evidence(), land: mask(1), disputed: mask(0), fine: mask(3),
        excluded: mask(1), trees: mask(1), newerOpenEvidence: true };
    assert.deepEqual(screen(input), [1, 1]);
    for (const change of [{ newerOpenEvidence: false }, { water: mask(1) }, { canopy: mask(1) },
        { impervious: mask(1) }, { land: mask(5) }, { ground: { open: mask(2), blocked: mask(0) } }]) {
        assert.deepEqual(screen({ ...input, ...change }), [0, 0]);
    }
});
