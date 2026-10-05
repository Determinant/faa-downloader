import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { mapWithPrefetch } from '../lib/concurrency.ts';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

test('prefetch lets ready regions pass a slow source and preserves result order', { timeout: 5000 }, async () => {
    const slow = deferred(), others = deferred();
    let completed = 0;
    const task = mapWithPrefetch([0, 1, 2, 3], 2, async value => {
        if (value === 0) await slow.promise;
        return value;
    }, async value => {
        if (value !== 0 && ++completed === 3) others.resolve();
        return value * 2;
    });
    try { await others.promise; } finally { slow.resolve(); }
    assert.deepEqual(await task, [0, 2, 4, 6]);
});

test('prefetch bounds prepared backlog while consumers are busy', { timeout: 5000 }, async () => {
    const gate = deferred(), filled = deferred();
    let prepared = 0, active = 0, peak = 0;
    const task = mapWithPrefetch([0, 1, 2, 3, 4, 5], 2, async value => {
        if (++prepared === 4) filled.resolve();
        return value;
    }, async value => {
        peak = Math.max(peak, ++active);
        await gate.promise;
        active--;
        return value;
    });
    try {
        await filled.promise;
        await setImmediate();
        assert.equal(prepared, 4, 'two consumers plus two preparing/ready regions');
        assert.equal(peak, 2);
    } finally { gate.resolve(); }
    assert.deepEqual(await task, [0, 1, 2, 3, 4, 5]);
});

test('prefetch stops admission on error and drains outstanding acquisition', async () => {
    const gate = deferred();
    const started: number[] = [];
    let settled = false;
    const task = mapWithPrefetch([0, 1, 2, 3], 2, async value => {
        started.push(value);
        if (value === 1) throw new Error('acquisition failed');
        await gate.promise;
        return value;
    }, async () => assert.fail('Failed preparation must not launch analysis'));
    const failure = assert.rejects(task, /acquisition failed/).then(() => { settled = true; });
    await setImmediate();
    assert.equal(settled, false);
    assert.deepEqual(started, [0, 1]);
    gate.resolve();
    await failure;
});
