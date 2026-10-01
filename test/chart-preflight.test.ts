import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildCharts } from '../download-charts.ts';

test('chart build fails before chart downloads or tiling if its XML edition is unavailable', async t => {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-chart-preflight-'));
    t.after(() => fs.rm(output, { recursive: true, force: true }));
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-01T09:00:59Z') });
    const requests: string[] = [];
    t.mock.method(globalThis, 'fetch', async input => {
        requests.push(String(input));
        return new Response('Unavailable', { status: 404 });
    });
    await assert.rejects(buildCharts({ output, help: false, force: false, concurrency: 1, tileConcurrency: 1 }), /404/);
    assert.deepEqual(requests, ['https://aeronav.faa.gov/d-tpp/2609/xml_data/d-tpp_Metafile.xml']);
    await assert.rejects(fs.access(path.join(output, 'charts')), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(output, 'zips')), { code: 'ENOENT' });
});
