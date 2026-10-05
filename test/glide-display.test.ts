import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { simplifyGlideOutline, type GlidePolygon } from '../lib/glide-display.ts';
import { findGlideLandingAreas, glideAreaPolygon, simplifyGlideLandingAreas } from '../lib/glide-areas.ts';
import { GdalPool, gdalCommand } from '../lib/gdal.ts';
import { FT, GLIDE_RULES, type GlideGrid, type GlideLandingArea } from '../lib/glide-model.ts';
import type { GlideSurface } from '../lib/glide-raster.ts';

const ringArea = (ring: number[][]) => Math.abs(ring.slice(1).reduce((a, p, i) =>
    a + ring[i][0] * p[1] - p[0] * ring[i][1], 0) / 2);
const area = (p: GlidePolygon) => ringArea(p.coordinates[0]) - p.coordinates.slice(1).reduce((a, r) => a + ringArea(r), 0);
const vertices = (p: GlidePolygon) => p.coordinates.reduce((a, r) => a + r.length - 1, 0);
const wkt = (p: GlidePolygon) => `POLYGON(${p.coordinates.map(r => `(${r.map(p => p.join(' ')).join(',')})`).join(',')})`;
const outline = (): GlidePolygon => ({ type: 'Polygon', coordinates: [
    [[0, 0], [1000, 0], [1000, 1000], [800, 1000], [800, 1010], [790, 1010], [790, 1000], [0, 1000], [0, 0]],
    [[100, 100], [140, 100], [140, 140], [130, 140], [130, 130], [120, 130], [120, 140], [100, 140], [100, 100]],
] });

test('inward shortcuts reduce rugged shells and holes without filling exclusions, in either winding', () => {
    for (const reverse of [false, true]) {
        const input = outline();
        if (reverse) input.coordinates = input.coordinates.map(r => [...r].reverse());
        const before = structuredClone(input), output = simplifyGlideOutline(input, 15);
        assert.deepEqual(input, before);
        assert.ok(output.coordinates[0].length < input.coordinates[0].length);
        assert.ok(output.coordinates[1].length < input.coordinates[1].length);
        assert.equal(output.coordinates.length, input.coordinates.length);
        assert.ok(ringArea(output.coordinates[0]) <= ringArea(input.coordinates[0]));
        assert.ok(ringArea(output.coordinates[1]) >= ringArea(input.coordinates[1]));
        assert.ok(area(output) >= area(input) * 0.98);
        for (const ring of output.coordinates) assert.deepEqual(ring[0], ring.at(-1));
    }
});

test('shape-defining tips, broad shallow bends and narrow connections survive local reduction', () => {
    const shapes = [
        // A 200 m long, 10 m wide arm costs less than 2% of the main field.
        [[0, 0], [1000, 0], [1000, 490], [1200, 490], [1200, 500], [1000, 500], [1000, 1000], [0, 1000], [0, 0]],
        // The shallow bend is not an extent: a taller part lies elsewhere.
        [[0, 0], [2000, 0], [2000, 1100], [1700, 1100], [1700, 1000], [1000, 1000], [600, 1010], [200, 1000], [0, 1000], [0, 0]],
        // Two large lobes share a narrow connection with four distinct mouths.
        [[0, 0], [400, 0], [400, 490], [600, 490], [600, 0], [1000, 0], [1000, 1000], [600, 1000],
            [600, 510], [400, 510], [400, 1000], [0, 1000], [0, 0]],
    ];
    for (const shape of shapes) for (const dense of [false, true]) for (const reversed of [false, true]) {
        const ring = shape.slice(0, -1).flatMap((p, i) => {
            const q = shape[i + 1], count = dense ? Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / 10) : 1;
            return Array.from({ length: count }, (_, j) => [p[0] + (q[0] - p[0]) * j / count, p[1] + (q[1] - p[1]) * j / count]);
        });
        if (reversed) ring.reverse();
        for (const start of shape.slice(0, -1)) {
            const index = ring.findIndex(p => p[0] === start[0] && p[1] === start[1]);
            const rotated = [...ring.slice(index), ...ring.slice(0, index), ring[index]];
            const reduced = simplifyGlideOutline({ type: 'Polygon', coordinates: [rotated] }, 15).coordinates[0];
            for (const point of shape) assert.ok(reduced.some(p => p[0] === point[0] && p[1] === point[1]),
                `lost shape point ${point}, dense=${dense}, reversed=${reversed}, start=${start}`);
        }
    }
});

test('larger and long narrow holes retain their exact outlines while compact tiny holes simplify', () => {
    const input = outline();
    const large = input.coordinates[1].map(([x, y]) => [x * 3, y * 3]);
    const long = input.coordinates[1].map(([x, y]) => [x * 3, y / 3]);
    input.coordinates.push(large, long);
    const result = simplifyGlideOutline(input, 15);
    assert.ok(result.coordinates[1].length < input.coordinates[1].length);
    assert.deepEqual(result.coordinates[2], large);
    assert.deepEqual(result.coordinates[3], long);
});

test('shortcuts respect total area and original-point distance budgets, including repeated removals', () => {
    const input = outline();
    const limited = simplifyGlideOutline(input, 15, 0.00001);
    assert.ok(area(input) - area(limited) <= area(input) * 0.00001 + 1e-8);
    assert.deepEqual(simplifyGlideOutline(input, 0), input);
    // A dense convex arc tempts repeated individually small corner removals.
    // Every original point must still be within tolerance of the resulting ring.
    const ring = Array.from({ length: 2000 }, (_, i) => [1000 * Math.cos(i * Math.PI / 1000), 1000 * Math.sin(i * Math.PI / 1000)]);
    ring.push(ring[0]);
    const dense: GlidePolygon = { type: 'Polygon', coordinates: [ring] };
    const output = simplifyGlideOutline(dense, 1);
    assert.ok(vertices(output) < vertices(dense));
    const result = output.coordinates[0];
    for (const [x, y] of ring) {
        let distance2 = Infinity;
        for (let i = 1; i < result.length; i++) {
            const a = result[i - 1], b = result[i], dx = b[0] - a[0], dy = b[1] - a[1];
            const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
            distance2 = Math.min(distance2, (x - a[0] - t * dx) ** 2 + (y - a[1] - t * dy) ** 2);
        }
        assert.ok(distance2 <= 1 + 1e-8);
    }
    assert.ok(area(output) >= area(dense) * 0.98);
});

test('display accepts detailed outlines exceeding the GeoJSON string limit on both backends', async t => {
    let native: GdalPool;
    try { native = await GdalPool.create(1); }
    catch { t.skip('Requires GDAL'); return; }
    t.after(() => native.close());
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-large-outline-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const scale = 6371008.8 * Math.PI / 180;
    const grid: GlideGrid = { width: 2000, height: 2000, cell: 10, west: 0, north: 20000,
        bounds: [0, 0, 20000 / scale, 20000 / scale], extent: [0, 0, 20000, 20000],
        srs: '+proj=eqc +lat_ts=0 +lon_0=0 +R=6371008.8 +units=m +no_defs',
        coordinate: (x, y) => [x * 10 / scale, (20000 - y * 10) / scale] };
    const q = (n: number) => Math.round(n / scale * 1e6);
    const encode = (points: number[][]) => {
        let x = 0, y = 0;
        const ring: number[] = [];
        for (const [px, py] of points) {
            const nx = q(px), ny = q(py);
            if (ring.length && nx === x && ny === y) continue;
            ring.push(nx - x, ny - y); x = nx; y = ny;
        }
        return ring;
    };
    // A large protected hole retains enough vertices to produce a >10 MB WKT
    // property in the former representation, like conus-w114-n43 chunk 29.
    const hole = Array.from({ length: 350_000 }, (_, i) => {
        const angle = -i * 2 * Math.PI / 350_000; // Clockwise hole, matching GeoJSONSeq winding.
        return [10000 + 8000 * Math.cos(angle), 10000 + 8000 * Math.sin(angle)];
    });
    const input: GlideLandingArea = [[q(1000), q(1000), q(2000), q(1000), 200, 3280, 123, 2, 0, 0],
        [encode([[100, 100], [19900, 100], [19900, 19900], [100, 19900]]), encode(hole)], 256];
    const cells = grid.width * grid.height;
    const surface = { hazards: new Uint8Array(cells).fill(1), known: new Uint8Array(cells).fill(1), cover: new Uint8Array(cells).fill(1) };
    const cli = await GdalPool.create(1, { library: null, version: native.version });
    t.after(() => cli.close());
    for (const pool of [native, cli]) {
        const result = await pool.run(() => simplifyGlideLandingAreas([input], grid, surface, directory));
        // Hash this large fixture so a regression produces a bounded failure diff.
        const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
        assert.equal(hash(result), hash([input]), 'the full outline, excluded hole, witness and flags survive');
    }
});

test('native display reduction validates topology, excluded holes, footprint containment and fallback on both backends', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-display-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const scale = 6371008.8 * Math.PI / 180;
    const grid: GlideGrid = { width: 120, height: 120, cell: 10, west: 0, north: 1200,
        bounds: [0, 0, 1200 / scale, 1200 / scale], extent: [0, 0, 1200, 1200],
        srs: '+proj=eqc +lat_ts=0 +lon_0=0 +R=6371008.8 +units=m +no_defs',
        coordinate: (x, y) => [x * 10 / scale, (1200 - y * 10) / scale] };
    const cells = grid.width * grid.height;
    const surface = { hazards: new Uint8Array(cells).fill(1), known: new Uint8Array(cells).fill(1), cover: new Uint8Array(cells).fill(1) };
    const fixture = (nearEdge: boolean): GlideLandingArea => {
        const polygon = outline();
        // A long shallow protrusion contains one side of the full-width fit.
        // It must retain its defining vertices even within the area budget.
        if (nearEdge) polygon.coordinates = [[[0, 0], [1000, 0], [1000, 1000], [700, 1000],
            [700, 1010], [300, 1010], [300, 1000], [0, 1000], [0, 0]]];
        const rings = polygon.coordinates.map(ring => {
            let x = 0, y = 0;
            return ring.slice(0, -1).flatMap(p => {
                const nx = Math.round(p[0] / scale * 1e6), ny = Math.round(p[1] / scale * 1e6);
                const result = [nx - x, ny - y]; x = nx; y = ny; return result;
            });
        });
        const q = (n: number) => Math.round(n / scale * 1e6);
        return [[q(nearEdge ? 302 : 200), q(nearEdge ? 1000 : 500), q(nearEdge ? 698 : 800), q(nearEdge ? 1000 : 500),
            nearEdge ? 60 : 200, nearEdge ? 1299 : 1968, 123, 1, 17, -9], rings, 256];
    };
    for (const library of [null, undefined]) {
        const pool = await GdalPool.create(1, { library, tools: ['ogr2ogr'] });
        try {
            await pool.run(async () => {
                const originals = [fixture(false), fixture(true)], saved = structuredClone(originals);
                const results = await simplifyGlideLandingAreas(originals, grid, surface, directory);
                assert.deepEqual(originals, saved);
                assert.equal(results.length, originals.length);
                assert.ok(vertices(glideAreaPolygon(results[0])) < vertices(glideAreaPolygon(originals[0])));
                for (const [i, output] of results.entries()) {
                    assert.deepEqual(output[0], originals[i][0]);
                    assert.equal(output[2], originals[i][2]);
                    const original = glideAreaPolygon(originals[i]), reduced = glideAreaPolygon(output);
                    assert.equal(reduced.coordinates.length, original.coordinates.length);
                    const [x0, y0, x1, y1, width] = output[0], half = width * FT * 1.01 / 2 / scale;
                    const witness: GlidePolygon = { type: 'Polygon', coordinates: [[[x0 / 1e6, y0 / 1e6 - half],
                        [x1 / 1e6, y1 / 1e6 - half], [x1 / 1e6, y1 / 1e6 + half], [x0 / 1e6, y0 / 1e6 + half], [x0 / 1e6, y0 / 1e6 - half]]] };
                    const input = path.join(directory, 'validation.geojson');
                    await fs.writeFile(input, JSON.stringify({ type: 'FeatureCollection', features: [
                        { type: 'Feature', properties: {}, geometry: original }] }));
                    const result = JSON.parse(await gdalCommand('ogr2ogr', ['-f', 'GeoJSON', '-dialect', 'SQLite', '-sql',
                        `SELECT ST_IsValid(r) AS valid,ST_Covers(geometry,r) AS contained,ST_Covers(r,w) AS witness,` +
                        `ST_Area(r)/ST_Area(geometry) AS fraction FROM ` +
                        `(SELECT geometry,ST_GeomFromText('${wkt(reduced)}',4326) AS r,ST_GeomFromText('${wkt(witness)}',4326) AS w FROM validation)`,
                        '/vsistdout/', input]));
                    const properties = result.features[0].properties;
                    assert.equal(properties.valid, 1);
                    assert.equal(properties.contained, 1);
                    assert.equal(properties.witness, 1);
                    assert.ok(properties.fraction >= 0.98 && properties.fraction <= 1);
                }
                assert.deepEqual(results[1], originals[1], 'a fit depending on the protrusion survives unchanged');
            });
        } finally { await pool.close(); }
    }
});

test('early polygon reduction preserves a long narrow arm within its display tolerance', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-shape-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const scale = 6371008.8 * Math.PI / 180;
    const grid: GlideGrid = { width: 100, height: 100, cell: 10, west: 0, north: 1000,
        bounds: [0, 0, 1000 / scale, 1000 / scale], extent: [0, 0, 1000, 1000],
        srs: '+proj=eqc +lat_ts=0 +lon_0=0 +R=6371008.8 +units=m +no_defs',
        coordinate: (x, y) => [x * 10 / scale, (1000 - y * 10) / scale] };
    const cells = grid.width * grid.height;
    const surface: GlideSurface = { known: new Uint8Array(cells).fill(1), cover: new Uint8Array(cells).fill(1),
        hazards: new Uint8Array(cells).fill(1), cropDependent: new Uint8Array(cells),
        elevationMin: new Float32Array(cells).fill(100), elevationMax: new Float32Array(cells).fill(100) };
    for (let y = 20; y < 80; y++) for (let x = 10; x < 90; x++) surface.hazards[y * grid.width + x] = 0;
    for (let y = 5; y < 20; y++) surface.hazards[y * grid.width + 30] = 0;
    const pool = await GdalPool.create(1);
    try {
        const areas = await pool.run(() => findGlideLandingAreas(surface, grid, directory));
        assert.equal(areas.length, 1);
        const ring = glideAreaPolygon(areas[0]).coordinates[0].map(p => p.map(n => n * scale));
        // Practical early generalization may bevel the 8 m-wide tip. Keep the
        // 150 m arm's extent without requiring both sub-tolerance corners.
        for (const x of [301, 309]) assert.ok(ring.some(p => Math.hypot(p[0] - x, p[1] - 949) <= GLIDE_RULES.areaSimplificationM + 0.15),
            `lost the narrow arm beyond the early simplification tolerance near ${x},949`);
    } finally { await pool.close(); }
});
