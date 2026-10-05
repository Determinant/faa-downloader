import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test, { type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { previewLabels } from '../lib/glide-preview-data.ts';

/** Exercise the real DOM handlers and request state; mapping is outside these state-transition tests. */
async function dashboard(t: TestContext, hash = '') {
    const dom = new JSDOM(await fs.readFile(new URL('../tools/glide-preview/index.html', import.meta.url), 'utf8'),
        { url: `http://127.0.0.1:4177/${hash}`, runScripts: 'outside-only' });
    t.after(() => dom.window.close());
    const w = dom.window, context = dom.getInternalVMContext();
    const panes = new Map(), shown = new Set(), events = new Map();
    let center = { lat: 37.5, lng: -98 }, zoom = 5;
    const map = {
        setView(c, z) { center = { lat: c[0], lng: c[1] }; zoom = z; events.get('moveend')?.(); return this; },
        createPane(n) { const pane = { style: {} }; panes.set(n, pane); return pane; },
        getPane: n => panes.get(n), hasLayer: l => shown.has(l), removeLayer(l) { shown.delete(l); return this; },
        on(n, fn) { events.set(n, fn); return this; },
        getCenter: () => center, getZoom: () => zoom,
        getBounds: () => ({ getWest: () => -120.1, getEast: () => -119.9, getSouth: () => 34.9, getNorth: () => 35.1 }),
    };
    const layer = () => ({ addTo() { shown.add(this); return this; }, clearLayers() { return this; }, addData() { return this; },
        bringToFront() { return this; }, addLayer() { return this; }, bindTooltip() { return this; }, on() { return this; } });
    w.L = { map: () => map, control: { zoom: layer, scale: layer }, tileLayer: layer,
        canvas: layer, geoJSON: layer, layerGroup: layer, rectangle: layer };
    w.URL.createObjectURL = () => 'blob:fixture'; w.URL.revokeObjectURL = () => {};
    // Tests explicitly flush refreshes so they can also inspect the debounce interval.
    w.setTimeout = () => 1; w.clearTimeout = () => {}; w.setInterval = () => 1;
    const requests: URLSearchParams[] = [];
    let defer = false, release: (() => void) | undefined;
    w.fetch = async input => {
        const url = new URL(input, w.location.href); let data;
        if (url.pathname === '/api/versions') data = { current: 1, versions: [1, 20] };
        else if (url.pathname === '/api/samples') data = [{ id: 'old', version: 20, title: 'Historical sample', center: [36.42, -119.8], zoom: 12 }];
        else {
            requests.push(url.searchParams);
            const sample = url.searchParams.get('sample'), version = sample ? 20 : Number(url.searchParams.get('version'));
            data = { features: [], coverage: [], meta: { source: sample ? 'sample' : 'live', version, currentVersion: 1,
                title: 'Fixture', timestamp: '2026-01-01', mode: 'detail', checkpointCount: 0,
                visibleChunks: 0, pendingChunks: 0, sampleCount: 0, labels: previewLabels(version) } };
            if (defer) { defer = false; await new Promise<void>(resolve => { release = resolve; }); }
        }
        return { ok: true, json: async () => data };
    };
    vm.runInContext(await fs.readFile(new URL('../tools/glide-preview/app.js', import.meta.url), 'utf8'), context);
    await new Promise(resolve => setImmediate(resolve));
    const element = id => w.document.getElementById(id);
    return { requests, element, w,
        choose(id: string, value: string) { element(id).value = value; element(id).dispatchEvent(new w.Event('change')); },
        refresh: () => vm.runInContext('refresh()', context),
        deferNext() { defer = true; }, release() { assert.ok(release); release(); },
        location: () => new URLSearchParams(w.location.hash.slice(1)),
    };
}

test('historical sample selection, live presets, coordinates and requests retain one version state', async t => {
    const ui = await dashboard(t);
    ui.choose('place', 'sample-old');
    assert.equal(ui.element('analysis-version').value, '20');
    assert.equal(ui.location().get('version'), '20'); assert.equal(ui.location().get('sample'), 'old');
    await ui.refresh();
    assert.equal(ui.requests.at(-1)!.get('version'), '20');
    ui.choose('place', 'valley'); await ui.refresh();
    assert.equal(ui.element('analysis-version').value, '20');
    assert.equal(ui.requests.at(-1)!.get('version'), '20'); assert.equal(ui.requests.at(-1)!.has('sample'), false);
    ui.element('coordinates').value = '36.42, -119.8';
    ui.element('coordinates-form').dispatchEvent(new ui.w.Event('submit', { cancelable: true }));
    await ui.refresh(); assert.equal(ui.requests.at(-1)!.get('version'), '20');
    ui.choose('analysis-version', '1'); await ui.refresh();
    assert.equal(ui.requests.at(-1)!.get('version'), '1'); assert.equal(ui.location().get('version'), '1');
});

test('restoring a sample URL adopts its actual version even when the old URL version disagrees', async t => {
    const ui = await dashboard(t, '#lat=36.42&lon=-119.8&zoom=12&version=1&sample=old');
    assert.equal(ui.requests.at(-1)!.get('version'), '20');
    assert.equal(ui.element('analysis-version').value, '20'); assert.equal(ui.location().get('version'), '20');
});

test('a response from the previous source cannot reset selection during the refresh debounce', async t => {
    const ui = await dashboard(t);
    ui.deferNext(); const pending = ui.refresh();
    ui.choose('place', 'sample-old'); ui.release(); await pending;
    assert.equal(ui.element('analysis-version').value, '20'); assert.equal(ui.location().get('sample'), 'old');
    await ui.refresh(); assert.equal(ui.element('version').textContent, 'v20');
});
