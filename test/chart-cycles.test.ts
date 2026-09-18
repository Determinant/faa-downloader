import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildChartCycles } from '../build-chart-cycles.ts';

test('cycles.json lists only dated directories, newest first, and refreshes removed editions', async t => {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-chart-cycles-'));
    t.after(() => fs.rm(output, { recursive: true, force: true }));
    const root = path.join(output, 'charts');
    for (const date of ['2026-09-03', '2026-10-01', '2026-09-31', 'route-history']) {
        await fs.mkdir(path.join(root, date), { recursive: true });
    }
    await fs.writeFile(path.join(root, '2026-11-26'), 'not a directory');
    await fs.symlink(path.join(root, '2026-09-03'), path.join(root, '2026-12-24'));
    const index = await buildChartCycles(output);
    assert.equal(index.schemaVersion, 1);
    assert.ok(Number.isFinite(Date.parse(index.generatedAt)));
    assert.deepEqual(index.cycles, ['2026-10-01', '2026-09-03']);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'cycles.json'), 'utf8')), index);
    await fs.rm(path.join(root, '2026-10-01'), { recursive: true });
    assert.deepEqual((await buildChartCycles(output)).cycles, ['2026-09-03']);
});
