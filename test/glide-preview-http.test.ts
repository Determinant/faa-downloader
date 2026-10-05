import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGlidePreviewServer } from '../lib/glide-preview.ts';

test('preview HTTP serves assets, sample metadata and versioned views through the separated readers', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-preview-http-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const directory = path.join(root, 'glide-preview/samples'); await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'old.json'), JSON.stringify({ id: 'old', title: 'Historical', center: [25, -98], zoom: 12,
        generatedAt: '2026-01-01', version: 20, features: [] }));
    const server = createGlidePreviewServer(root);
    t.after(() => new Promise<void>((resolve, reject) => {
        server.closeAllConnections(); server.close(error => error ? reject(error) : resolve());
    }));
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const url = `http://127.0.0.1:${address.port}`;
    for (const file of ['/', '/app.js', '/style.css', '/vendor/leaflet.js', '/vendor/leaflet.css']) {
        const response = await fetch(url + file); assert.equal(response.status, 200); assert.ok((await response.text()).length);
    }
    const samples = await (await fetch(url + '/api/samples')).json();
    assert.equal(samples[0].count, 0); assert.equal('features' in samples[0], false);
    assert.deepEqual((await (await fetch(url + '/api/versions')).json()).versions, [1, 20]);
    const view = await (await fetch(url + '/api/view?bbox=-98,25,-97.875,25.125&zoom=12&version=1&sample=old')).json();
    assert.equal(view.meta.source, 'sample'); assert.equal(view.meta.version, 20);
    assert.equal(view.meta.labels.fallback, 'Measured fits · 600+ ft × 60+ ft');
    assert.equal((await fetch(url + '/api/view?bbox=invalid')).status, 400);
    assert.equal((await fetch(url + '/api/samples', { method: 'POST' })).status, 405);
});
