import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { acquireChartBuildLock } from '../lib/chart-build-lock.ts';

async function fixture(t: TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-chart-lock-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const base = path.join(root, 'sheet');
    return { root, base, lock: `${base}.build.lock` };
}

for (const legacy of [true, false]) {
    test(`delayed cleanup of a stale ${legacy ? 'file' : 'directory'} lock cannot delete its replacement`,
        { timeout: 5000 }, async t => {
        const f = await fixture(t);
        const staleOwner = legacy ? f.lock : path.join(f.lock, `2147483647-${randomUUID()}.json`);
        if (!legacy) await fs.mkdir(f.lock);
        await fs.writeFile(staleOwner, JSON.stringify({ pid: 2_147_483_647, token: 'dead' }));
        const unlink = fs.unlink;
        let releaseRemovals: () => void;
        let signalAcquired: () => void;
        const bothRemoving = new Promise<void>(resolve => { releaseRemovals = resolve; });
        const acquired = new Promise<void>(resolve => { signalAcquired = resolve; });
        let removals = 0;
        const mock = t.mock.method(fs, 'unlink', async file => {
            if (file === staleOwner) {
                const order = ++removals;
                // Hold the old owner until both contenders have observed it,
                // then delay one removal until the other owns the new lock.
                if (order === 2) releaseRemovals();
                await bothRemoving;
                if (order === 2) await acquired;
            }
            return unlink(file);
        });
        let owners: Array<() => Promise<void>> = [];
        try {
            const claim = () => acquireChartBuildLock(f.base).then(release => {
                signalAcquired();
                return release;
            });
            const results = await Promise.allSettled([claim(), claim()]);
            owners = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
            assert.equal(removals, 2, 'both contenders reached the delayed cleanup');
            assert.equal(owners.length, 1);
            await assert.rejects(acquireChartBuildLock(f.base), /already in progress/);
        } finally {
            mock.mock.restore();
            for (const release of owners) await release();
        }
        assert.deepEqual(await fs.readdir(f.root), []);
    });
}

test('a killed builder leaves a recoverable lock with a complete owner', { timeout: 10_000 }, async t => {
    const f = await fixture(t);
    const module = new URL('../lib/chart-build-lock.ts', import.meta.url).href;
    const child = spawn(process.execPath, ['--import=tsx', '--input-type=module', '-e', `
        import { acquireChartBuildLock } from ${JSON.stringify(module)};
        await acquireChartBuildLock(${JSON.stringify(f.base)});
        process.on('message', () => {});
        process.send('acquired');
    `], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = once(child, 'exit');
    t.after(() => { child.kill('SIGKILL'); });
    const ready = await Promise.race([
        once(child, 'message'),
        exited.then(() => { throw new Error('Lock owner exited before acquiring its lock'); })
    ]);
    assert.equal(ready[0], 'acquired');
    const [marker] = await fs.readdir(f.lock);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.lock, marker), 'utf8')).pid, child.pid);
    await assert.rejects(acquireChartBuildLock(f.base), /already in progress/);
    child.kill('SIGKILL');
    await exited;
    const release = await acquireChartBuildLock(f.base);
    await release();
    assert.deepEqual(await fs.readdir(f.root), []);
});

test('lock initialization is invisible until its owner marker is complete', { timeout: 5000 }, async t => {
    const f = await fixture(t);
    const writeFile = fs.writeFile;
    let signalWriting: () => void;
    let resumeWriting: () => void;
    const writing = new Promise<void>(resolve => { signalWriting = resolve; });
    const resume = new Promise<void>(resolve => { resumeWriting = resolve; });
    let paused = false;
    const mock = t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof writeFile>) => {
        if (!paused && String(args[0]).includes('.build.lock.pending-')) {
            paused = true;
            signalWriting();
            await resume;
        }
        return writeFile(...args);
    });
    const pending = acquireChartBuildLock(f.base);
    let release: (() => Promise<void>) | undefined;
    try {
        await writing;
        await assert.rejects(fs.access(f.lock), /ENOENT/);
        release = await acquireChartBuildLock(f.base);
        const rejected = assert.rejects(pending, /already in progress/);
        resumeWriting();
        await rejected;
    } finally {
        resumeWriting();
        mock.mock.restore();
        const abandoned = await pending.catch(() => undefined);
        await abandoned?.();
        await release?.();
    }
    assert.deepEqual(await fs.readdir(f.root), []);
});

test('legacy incomplete locks recover after allowing an active writer time to finish', async t => {
    const f = await fixture(t);
    for (const contents of ['', '{"pid":', 'null', '{}']) {
        await fs.writeFile(f.lock, contents);
        await assert.rejects(acquireChartBuildLock(f.base), /already in progress/);
        const stale = new Date(Date.now() - 120_000);
        await fs.utimes(f.lock, stale, stale);
        const release = await acquireChartBuildLock(f.base);
        await release();
    }
    assert.deepEqual(await fs.readdir(f.root), []);
});

test('delayed release cannot remove a replacement owner', async t => {
    const f = await fixture(t);
    const oldRelease = await acquireChartBuildLock(f.base);
    await oldRelease();
    const release = await acquireChartBuildLock(f.base);
    try {
        await oldRelease();
        await assert.rejects(acquireChartBuildLock(f.base), /already in progress/);
    } finally { await release(); }
    assert.deepEqual(await fs.readdir(f.root), []);
});

test('an empty directory left by interrupted lock cleanup can be acquired', async t => {
    const f = await fixture(t);
    await fs.mkdir(f.lock);
    const release = await acquireChartBuildLock(f.base);
    await release();
    assert.deepEqual(await fs.readdir(f.root), []);
});
