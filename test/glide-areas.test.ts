import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findGlideLandingGround } from '../lib/glide-analysis.ts';
import { findAdaptiveGlideLandingAreas, findGlideLandingAreas, glideAreaPolygon, mergeGlideLandingAreas, selectQuantizedGlideAreas } from '../lib/glide-areas.ts';
import type { GlideGrid, GlideLandingArea } from '../lib/glide-model.ts';
import type { GlideSurface } from '../lib/glide-raster.ts';
import { removeSmallGlideHoles } from '../lib/glide-display.ts';

function field() {
    const width = 400, height = 200, cells = width * height, scale = 6371008.8 * Math.PI / 180;
    const grid: GlideGrid = { width, height, cell: 10, west: 0, north: 2000,
        bounds: [0, 0, 0.04, 0.02], extent: [0, 0, 4000, 2000],
        srs: '+proj=eqc +lat_ts=0 +lon_0=0 +R=6371008.8 +units=m +no_defs',
        coordinate: (x, y) => [x * 10 / scale, (height - y) * 10 / scale] };
    const surface: GlideSurface = { known: new Uint8Array(cells).fill(1),
        elevationMin: new Float32Array(cells).fill(100), elevationMax: new Float32Array(cells).fill(100),
        cover: new Uint8Array(cells).fill(1), cropDependent: new Uint8Array(cells), hazards: new Uint8Array(cells).fill(1) };
    for (let y = 30; y < 150; y++) for (let x = 40; x < 340; x++) surface.hazards[y * width + x] = 0;
    return { grid, surface };
}

test('one qualifying fit marks connected ground, including other headings, but not a corner-touching island', () => {
    const { grid, surface } = field();
    for (let y = 150; y < 165; y++) for (let x = 340; x < 355; x++) surface.hazards[y * grid.width + x] = 0;
    const { labels, qualifications } = findGlideLandingGround(surface, grid);
    assert.equal(qualifications.size, 1);
    assert.equal([...qualifications.values()][0][7], 2);
    assert.ok(labels[31 * grid.width + 41]);
    assert.equal(labels[149 * grid.width + 339], labels[31 * grid.width + 41]);
    assert.equal(labels[151 * grid.width + 341], 0);
});

test('a cross-field exclusion separates connected areas and downgrades both short fits', () => {
    const { grid, surface } = field();
    for (let y = 0; y < grid.height; y++) if (y < 60 || y >= 100) surface.hazards.fill(1, y * grid.width, (y + 1) * grid.width);
    for (let y = 0; y < grid.height; y++) surface.hazards[y * grid.width + 190] = 1;
    // Two ~550 m fields: each fits purple but neither fits 2,000 ft.
    for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
        if (x < 135 || x > 245) surface.hazards[y * grid.width + x] = 1;
    }
    const { labels, qualifications } = findGlideLandingGround(surface, grid);
    assert.equal(qualifications.size, 2);
    assert.notEqual(labels[80 * grid.width + 150], labels[80 * grid.width + 230]);
    assert.ok([...qualifications.values()].every(record => record[7] === 1));
});

let hasGdal = true;
try { execFileSync('gdal', ['raster', 'polygonize', '--help'], { stdio: 'ignore' }); }
catch { hasGdal = false; }

test('post-rounding validation retains the screened outline and rejects an invalid fallback or a severed full-width fit',
    { skip: !hasGdal }, async t => {
        const work = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-quantized-test-'));
        t.after(() => fs.rm(work, { recursive: true, force: true }));
        const { grid } = field();
        const ring = (points: number[][]) => {
            let x = 0, y = 0;
            return points.flatMap(([nx, ny]) => { const delta = [nx - x, ny - y]; x = nx; y = ny; return delta; });
        };
        const original: GlideLandingArea = [[5000, 5000, 15000, 5000, 200, 3500, 100, 2, 0, 0],
            [ring([[1000, 1000], [20000, 1000], [20000, 9000], [1000, 9000]])], 1];
        const invalid: GlideLandingArea = [original[0],
            [ring([[1000, 1000], [20000, 9000], [20000, 1000], [1000, 9000]])], original[2]];
        assert.deepEqual(await selectQuantizedGlideAreas([invalid], [original], grid, work), [original]);
        assert.equal((await selectQuantizedGlideAreas([original], [invalid], grid, work))[0], original,
            'valid rounded output is unchanged');
        await assert.rejects(selectQuantizedGlideAreas([invalid], [invalid], grid, work), /Original glide outline/);
        const severed = structuredClone(original);
        // Endpoints and centerline remain inside; the 200-foot rectangle does not.
        severed[1].push(ring([[9000, 5100], [9500, 5100], [9500, 5300], [9000, 5300]]));
        assert.deepEqual(await selectQuantizedGlideAreas([severed], [original], grid, work), [original]);
    });

test('display removes compact tiny holes but keeps vegetation, hazards, unknown terrain and significant holes', () => {
    const { grid, surface } = field();
    surface.hazards.fill(0);
    const box = (x: number, y: number, w: number, h: number) =>
        [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
    const shell = box(500, 500, 3000, 1000), tiny = box(600, 600, 40, 40);
    const hazard = box(800, 600, 20, 20), unknown = box(1000, 600, 20, 20), vegetation = box(1100, 600, 20, 20), terrain = box(900, 600, 20, 20);
    const long = box(1200, 600, 100, 10), large = box(1600, 600, 100, 100);
    const index = (x: number, y: number) => Math.floor((grid.north - y) / grid.cell) * grid.width + Math.floor(x / grid.cell);
    surface.hazards[index(805, 605)] = 1;
    surface.known[index(1005, 605)] = 0;
    surface.cover[index(1105, 605)] = 0;
    surface.terrainBand = new Uint8Array(surface.cover.length).fill(1);
    surface.terrainBand[index(905, 605)] = 0;
    const polygon = { type: 'Polygon' as const, coordinates: [shell, tiny, hazard, unknown, vegetation, terrain, long, large] };
    const before = structuredClone(polygon);
    assert.deepEqual(removeSmallGlideHoles(polygon, grid, surface).coordinates, [shell, hazard, unknown, vegetation, terrain, long, large]);
    assert.deepEqual(polygon, before, 'display processing never mutates the screened geometry');
});

test('many tiny holes cannot inflate a field beyond the cumulative display-fill budget', () => {
    const { grid, surface } = field(); surface.hazards.fill(0);
    const box = (x: number, y: number, w: number, h: number) =>
        [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
    // 60,000 m² envelope, 3 × 400 m² holes: 2% permits two fills, not three.
    const polygon = { type: 'Polygon' as const, coordinates: [box(500, 500, 300, 200),
        box(520, 520, 20, 20), box(580, 520, 20, 20), box(640, 520, 20, 20)] };
    const reduced = removeSmallGlideHoles(polygon, grid, surface);
    assert.equal(reduced.coordinates.length, 2);
    assert.deepEqual(reduced.coordinates[1], polygon.coordinates[3]);
});

test('native area reduction preserves excluded holes and dissolves overlapping chunk boundaries',
    { skip: hasGdal ? false : 'Requires GDAL 3.11 and GEOS' }, async t => {
        const work = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-areas-test-'));
        t.after(() => fs.rm(work, { recursive: true, force: true }));
        const { grid, surface } = field();
        for (let y = 95; y < 105; y++) for (let x = 195; x < 205; x++) surface.hazards[y * grid.width + x] = 1;
        // A 20 m vegetation island is below the cosmetic hole-fill limit.
        // It still must survive the entire polygonization/display path.
        for (let y = 115; y < 117; y++) for (let x = 250; x < 252; x++) surface.cover[y * grid.width + x] = 0;
        const areas = await findGlideLandingAreas(surface, grid, work);
        assert.equal(areas.length, 1);
        const polygon = glideAreaPolygon(areas[0]);
        assert.equal(polygon.coordinates.length, 3, 'hazard and vegetation exclusions both remain holes');
        const area = (ring: number[][]) => Math.abs(ring.slice(1).reduce((sum, p, i) =>
            sum + ring[i][0] * p[1] - p[0] * ring[i][1], 0)) / 2;
        const footprint = area(polygon.coordinates[0]);
        assert.ok(footprint > 0.00025, 'show the entire screened field, not a runway bar');
        assert.equal(areas[0][2], 0);
        const conditional = structuredClone(areas[0]); conditional[2] = 1;
        const merged = await mergeGlideLandingAreas([...areas, conditional], work);
        assert.equal(merged.length, 1);
        assert.equal(glideAreaPolygon(merged[0]).coordinates.length, 3);
        assert.equal(merged[0][0][7], 2);
        assert.equal(merged[0][2], 1, 'a merged area retains crop uncertainty from any contributing patch');
    });

test('two-mask screening preserves preferred geometry and never promotes scrub by length',
    { skip: hasGdal ? false : 'Requires GDAL' }, async t => {
        const work = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-adaptive-test-'));
        t.after(() => fs.rm(work, { recursive: true, force: true }));
        const { grid, surface } = field();
        const original = await findGlideLandingAreas(surface, grid, work);
        surface.shrubBand = new Uint8Array(surface.cover.length);
        // Scrub outside the qualified field cannot change its preferred result.
        for (let y = 0; y < grid.height; y++) surface.shrubBand.fill(2, y * grid.width, y * grid.width + 20);
        assert.deepEqual(await findAdaptiveGlideLandingAreas(surface, grid, work), original);
        for (const band of [1, 2, 3]) {
            surface.shrubBand.fill(band);
            const fallback = await findAdaptiveGlideLandingAreas(surface, grid, work);
            assert.equal(fallback.length, 1);
            assert.ok(fallback[0][0][5] >= 1500);
            assert.equal(fallback[0][0][7], 1, 'long scrub fit stays best effort');
            assert.equal(fallback[0][2], 256 | (band === 1 ? 2 : 6));
            const merged = await mergeGlideLandingAreas([...original, ...fallback], work);
            assert.equal(merged.length, 2, 'overlap cannot merge surface uncertainty into preferred ground');
            assert.ok(merged.some(a => a[0][7] === 2 && a[2] === 0));
        }
        // Best effort is one complete mask, not a stack of disconnected
        // quality stages. Green below must remain unchanged and usable.
        surface.shrubBand.fill(3);
        const strictCover = Uint8Array.from(surface.cover, (value, i) => i % grid.width >= 40 && i % grid.width < 180 ? value : 0);
        for (let y = 0; y < grid.height; y++) surface.shrubBand.fill(0, y * grid.width + 40, y * grid.width + 180);
        const preferred = await findGlideLandingAreas({ ...surface, cover: strictCover }, grid, work);
        const combined = await findAdaptiveGlideLandingAreas(surface, grid, work);
        assert.ok(preferred.length && preferred.every(area => area[0][7] === 2));
        assert.deepEqual(combined.slice(0, preferred.length), preferred);
        assert.ok(combined.length > preferred.length && combined.slice(preferred.length).every(area => area[0][7] === 1));
        surface.known.fill(0);
        assert.deepEqual(await findAdaptiveGlideLandingAreas(surface, grid, work), [], 'adaptation never approves unknown terrain');
    });


test('urban, smooth-slope and narrower-building candidates stay purple, while independent strict ground is preserved',
    { skip: hasGdal ? false : 'Requires GDAL' }, async t => {
        const work = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-v15-areas-'));
        t.after(() => fs.rm(work, { recursive: true, force: true }));
        for (const kind of ['urban', 'slope', 'buildings', 'mixed-open'] as const) {
            const { grid, surface } = field();
            if (kind === 'mixed-open') surface.mixedOpen = new Uint8Array(surface.cover.length).fill(1);
            if (kind === 'urban') surface.urban = new Uint8Array(surface.cover.length).fill(1);
            if (kind === 'buildings') surface.buildingFallback = new Uint8Array(surface.cover.length).fill(1);
            if (kind === 'slope') for (let i = 0; i < surface.cover.length; i++) {
                surface.elevationMin[i] = surface.elevationMax[i] = 100 + (i % grid.width) * 0.4;
            }
            const areas = await findAdaptiveGlideLandingAreas(surface, grid, work);
            assert.ok(areas.length, kind);
            assert.ok(areas.every(a => a[0][7] === 1 && a[0][5] >= 1500), kind);
            assert.ok(areas.every(a => a[2] & (kind === 'urban' ? 32 : kind === 'slope' ? 16 : kind === 'mixed-open' ? 128 : 64)), kind);
        }
        const { grid, surface } = field();
        // A hazard separates a flat field from a smooth inclined field.
        for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
            const i = y * grid.width + x;
            if (x >= 185 && x <= 205) surface.hazards[i] = 1;
            if (x > 205) surface.elevationMin[i] = surface.elevationMax[i] = 100 + (x - 205) * 0.4;
        }
        const original = await findGlideLandingAreas(surface, grid, work);
        const adaptive = await findAdaptiveGlideLandingAreas(surface, grid, work);
        assert.ok(original.length && original.every(a => a[0][7] === 2));
        assert.deepEqual(adaptive.slice(0, original.length), original);
        assert.ok(adaptive.slice(original.length).some(a => a[2] & 16));
    });


test('100 ft purple footprint recovers narrow ground but never upgrades it to green or crosses an exclusion',
    { skip: hasGdal ? false : 'Requires GDAL' }, async t => {
        const work = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-narrow-'));
        t.after(() => fs.rm(work, { recursive: true, force: true }));
        const { grid, surface } = field();
        surface.hazards.fill(1);
        for (let y = 60; y < 65; y++) for (let x = 40; x < 200; x++) surface.hazards[y * grid.width + x] = 0;
        assert.equal((await findGlideLandingAreas(surface, grid, work)).length, 0);
        const areas = await findAdaptiveGlideLandingAreas(surface, grid, work);
        assert.equal(areas.length, 1);
        assert.equal(areas[0][0][4], 100);
        assert.equal(areas[0][0][7], 1);
        assert.ok(areas[0][2] & 256);
        for (let y = 60; y < 65; y++) for (let x = 55; x < 200; x += 15) surface.hazards[y * grid.width + x] = 1;
        assert.equal((await findAdaptiveGlideLandingAreas(surface, grid, work)).length, 0, 'cannot bridge short separated fragments');
    });


test('last-resort search retains separate small openings and prefers gentler ground over an adjoining rough slope',
    { skip: hasGdal ? false : 'Requires GDAL' }, async t => {
        const work = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-local-fallback-'));
        t.after(() => fs.rm(work, { recursive: true, force: true }));
        const { grid, surface } = field();
        surface.hazards.fill(1);
        // A 700 m field touching a constrained slope, plus an isolated 240 × 30 m opening.
        for (let y = 40; y < 90; y++) for (let x = 40; x < 110; x++) surface.hazards[y * grid.width + x] = 0;
        for (let y = 130; y < 133; y++) for (let x = 250; x < 274; x++) surface.hazards[y * grid.width + x] = 0;
        surface.terrainBand = new Uint8Array(surface.cover.length).fill(2);
        for (let y = 60; y < 90; y++) surface.terrainBand.fill(3, y * grid.width + 40, y * grid.width + 110);
        const areas = await findAdaptiveGlideLandingAreas(surface, grid, work);
        assert.equal(areas.length, 2, 'a larger field cannot suppress a disconnected local opening');
        assert.ok(areas.every(a => a[0][7] === 1 && (a[2] & 256)));
        const short = areas.find(a => a[0][5] < 1500)!;
        assert.ok(short[0][5] >= 600 && short[0][4] === 60);
        const gentle = areas.find(a => a !== short)!;
        const boundary = grid.coordinate(0, 60)[1];
        assert.ok(glideAreaPolygon(gentle).coordinates[0].every(p => p[1] >= boundary),
            'a gentler fit must not fill the adjoining broader terrain band');
        // The hard floor is still physical: fragment that short opening with a wire.
        for (let y = 130; y < 133; y++) surface.hazards[y * grid.width + 262] = 1;
        assert.equal((await findAdaptiveGlideLandingAreas(surface, grid, work)).length, 1);
    });

test('each gentle opening keeps its own fit after a broader-terrain connection is removed',
    { skip: hasGdal ? false : 'Requires GDAL' }, async t => {
        const work = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-split-openings-'));
        t.after(() => fs.rm(work, { recursive: true, force: true }));
        const { grid, surface } = field();
        surface.hazards.fill(1);
        surface.terrainBand = new Uint8Array(surface.cover.length).fill(2);
        // Two 700 x 200 m openings, joined by a 20 m strip of broader terrain.
        for (const left of [40, 160]) for (let y = 40; y < 60; y++) for (let x = left; x < left + 70; x++) {
            surface.hazards[y * grid.width + x] = 0;
        }
        for (let y = 49; y < 51; y++) for (let x = 110; x < 160; x++) {
            surface.hazards[y * grid.width + x] = 0;
            surface.terrainBand[y * grid.width + x] = 3;
        }
        const areas = await findAdaptiveGlideLandingAreas(surface, grid, work);
        assert.equal(areas.length, 2, 'both independent final openings need their own qualified fit');
        assert.ok(areas.every(a => a[0][7] === 1 && a[0][5] >= 1500));
        const centers = areas.map(a => (a[0][0] + a[0][2]) / 2e6).sort((a, b) => a - b);
        assert.ok(centers[0] < grid.coordinate(110, 0)[0]);
        assert.ok(centers[1] > grid.coordinate(160, 0)[0]);
        for (const area of areas) {
            const xs = glideAreaPolygon(area).coordinates[0].map(p => p[0]);
            assert.ok(Math.max(...xs) <= grid.coordinate(110, 0)[0] || Math.min(...xs) >= grid.coordinate(160, 0)[0]);
        }
        // An undersized remnant still cannot borrow the other field's fit.
        for (let y = 40; y < 60; y++) for (let x = 160; x < 230; x++) {
            if (x >= 170 || y >= 50) surface.hazards[y * grid.width + x] = 1;
        }
        assert.equal((await findAdaptiveGlideLandingAreas(surface, grid, work)).length, 1);
    });
