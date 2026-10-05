import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { expandBounds, GLIDE_RULES, VECTOR_ROLES, type GlideGrid, type ResolvedRegion, type VectorRole } from '../lib/glide-model.ts';
import { hazardBuffer, readGlideHazards, readGlideHazardMasks } from '../lib/glide-raster.ts';
import { GdalPool, gdalCommand } from '../lib/gdal.ts';

let hasGdal = true;
try { for (const tool of ['ogr2ogr', 'gdal_rasterize']) execFileSync(tool, ['--version'], { stdio: 'ignore' }); }
catch { hasGdal = false; }
const gdalTest = { skip: hasGdal ? false : 'Requires the glide builder GDAL tools' };
// Exercise both execution paths against the same safety and cleanup assertions.
function hazardTest(name: string, options: typeof gdalTest, run: (t: test.TestContext) => Promise<void>) {
    test(name, options, async t => {
        await t.test('CLI', run);
        const pool = await GdalPool.create(2);
        try {
            if (pool.library) await t.test('persistent GDAL', child => pool.run(() => run(child)));
        } finally { await pool.close(); }
    });
}
const metrePerDegree = 6371008.8 * Math.PI / 180;
const coordinate = (x: number, y: number) => [x / metrePerDegree, y / metrePerDegree];
const grid: GlideGrid = { width: 80, height: 80, cell: 10, west: 0, north: 800,
    bounds: [0, 0, 800 / metrePerDegree, 800 / metrePerDegree], extent: [0, 0, 800, 800],
    srs: '+proj=eqc +lat_ts=0 +lon_0=0 +R=6371008.8 +units=m +no_defs',
    coordinate: (x, y) => coordinate(x * 10, 800 - y * 10) as [number, number] };

hazardTest('purple ground setbacks narrow without crossing buildings or barriers', gdalTest, async t => {
    const geometry = { type: 'Polygon', coordinates: [[coordinate(390, 390), coordinate(410, 390),
        coordinate(410, 410), coordinate(390, 410), coordinate(390, 390)]] };
    const { work, region } = await setup(t, 'buildings', [{ type: 'Feature', properties: {}, geometry }]);
    region.sources.buildings[0].buildingSource = 'footprint';
    const masks = await readGlideHazardMasks(region, grid, work, new Uint8Array(grid.width * grid.height).fill(1));
    assert.equal(masks.losses[0].cells, masks.fallback.reduce((sum, v) => sum + v, 0));
    assert.equal(masks.preferred[40 * 80 + 44], 1);
    assert.equal(masks.fallback[40 * 80 + 44], 0);
    assert.equal(masks.fallback[40 * 80 + 40], 1, 'building itself stays excluded');
    region.sources.buildings[0].buildingSource = 'ground-barrier';
    const barrier = await readGlideHazardMasks(region, grid, work);
    assert.equal(barrier.preferred[40 * 80 + 46], 1, 'green retains its barrier margin');
    assert.equal(barrier.fallback[40 * 80 + 46], 0);
    assert.equal(barrier.fallback[40 * 80 + 40], 1, 'the barrier itself stays blocked');
});

async function setup(t: { after: (fn: () => Promise<void>) => void }, role: VectorRole, features: unknown[],
    obstacleSource?: 'mapped' | 'faa-dof') {
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-hazards-'));
    t.after(() => fs.rm(work, { recursive: true, force: true }));
    const file = path.join(work, 'source.geojson');
    const bytes = Buffer.from(JSON.stringify({ type: 'FeatureCollection', features }));
    await fs.writeFile(file, bytes);
    const sources = Object.fromEntries(VECTOR_ROLES.map(name => [name, []])) as ResolvedRegion['sources'];
    sources[role] = [{ file, name: 'hazard fixture', date: '2026-01-01', attribution: 'fixture',
        bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), obstacleSource }];
    const region: ResolvedRegion = { id: 'fixture', bounds: grid.bounds,
        coverageBounds: expandBounds(grid.bounds, GLIDE_RULES.inventoryHaloM), sources };
    return { work, region };
}

hazardTest('empty native and streamed hazard layers produce clear masks and clean their temporary files', gdalTest, async t => {
    for (const role of VECTOR_ROLES) {
        const { work, region } = await setup(t, role, []);
        assert.ok((await readGlideHazards(region, grid, work)).every(value => value === 0), role);
        assert.deepEqual(await fs.readdir(work), ['source.geojson']);
    }
});

hazardTest('native clipping preserves outside hazards, crossing lines, and holes in enclosing polygons', gdalTest, async t => {
    const cases: [VectorRole, unknown, [number, number], [number, number]][] = [
        ['buildings', { type: 'Point', coordinates: coordinate(-40, 400) }, [0, 40], [20, 40]],
        ['powerlines', { type: 'LineString', coordinates: [coordinate(-20000, 400), coordinate(20000, 400)] }, [40, 40], [40, 10]],
        ['water', { type: 'Polygon', coordinates: [
            [[-20000, -20000], [20000, -20000], [20000, 20000], [-20000, 20000], [-20000, -20000]],
            [[200, 200], [200, 600], [600, 600], [600, 200], [200, 200]],
        ].map(ring => ring.map(([x, y]) => coordinate(x, y))) }, [0, 0], [40, 40]],
    ];
    for (const [role, geometry, blocked, clear] of cases) {
        const { work, region } = await setup(t, role, [{ type: 'Feature', properties: {}, geometry }]);
        const mask = await readGlideHazards(region, grid, work);
        assert.equal(mask[blocked[1] * grid.width + blocked[0]], 1, role);
        assert.equal(mask[clear[1] * grid.width + clear[0]], 0, role);
    }
});

hazardTest('streamed high balloons retain their complete clearance and report malformed heights', gdalTest, async t => {
    const feature = { type: 'Feature', id: 'balloon', properties: {
        structureType: 'BALLOON', heightAglFt: 13997, horizontalAccuracyCode: '9',
    }, geometry: { type: 'Point', coordinates: coordinate(-8000, 400) } };
    const { work, region } = await setup(t, 'obstacles', [feature]);
    const mask = await readGlideHazards(region, grid, work);
    assert.equal(mask[40 * grid.width], 1);
    assert.equal(mask[40 * grid.width + 79], 0);
    const bad = await setup(t, 'obstacles', [{ ...feature, properties: { ...feature.properties, heightAglFt: 'bad' } }]);
    await assert.rejects(readGlideHazards(bad.region, grid, bad.work), /hazard fixture: balloon.*Invalid obstacle height/);
    assert.deepEqual(await fs.readdir(bad.work), ['source.geojson']);
});

hazardTest('mapped pylon streaming keeps its local exclusion without blocking the whole field', gdalTest, async t => {
    const feature = { type: 'Feature', properties: { structureType: 'power_tower', heightM: 0 },
        geometry: { type: 'Point', coordinates: coordinate(400, 400) } };
    const { work, region } = await setup(t, 'obstacles', [feature], 'mapped');
    const mask = await readGlideHazards(region, grid, work);
    assert.equal(mask[40 * grid.width + 40], 1, 'pylon itself is excluded');
    assert.equal(mask[40 * grid.width + 50], 1, 'nearby ground is excluded');
    assert.equal(mask[40 * grid.width + 60], 0, 'ground 200 m away no longer inherits a 1 NM allowance');
    region.sources.obstacles[0].obstacleSource = 'faa-dof';
    assert.ok((await readGlideHazards(region, grid, work)).every(Boolean), 'FAA unknown accuracy remains conservative');
});

hazardTest('typed footpaths use their own setback while vehicle, rail and unknown segments keep road clearance', gdalTest, async t => {
    for (const kind of ['footway', 'steps', 'residential', 'rail', null]) {
        const { work, region } = await setup(t, 'roads', [{ type: 'Feature', properties: { class: kind },
            geometry: { type: 'LineString', coordinates: [coordinate(0, 405), coordinate(800, 405)] } }]);
        region.sources.roads[0].roadSource = 'typed';
        const masks = await readGlideHazardMasks(region, grid, work);
        for (const mask of [masks.preferred, masks.fallback]) {
            assert.equal(mask[39 * 80 + 40], 1, 'the segment itself remains blocked in both tiers');
            assert.equal(mask[42 * 80 + 40], ['footway', 'steps'].includes(kind!) ? 0 : 1);
        }
        assert.equal(masks.preferred[40 * 80 + 40], 1, 'preferred paths retain their setback');
        assert.equal(masks.fallback[40 * 80 + 40], kind === 'footway' ? 0 : 1,
            'zero path setback leaves adjacent cells clear; steps and roads retain their margins');
        region.sources.roads[0].roadSource = undefined;
        assert.equal((await readGlideHazards(region, grid, work))[42 * 80 + 40], 1, 'legacy sources retain 30 m');
    }
});

hazardTest('shared and differing hazard buffers match independent complete raster passes, including overlap counts', gdalTest, async t => {
    const point = (x: number, y: number, properties: object) => ({ type: 'Feature', properties,
        geometry: { type: 'Point', coordinates: coordinate(x, y) } });
    const line = (x0: number, y0: number, x1: number, y1: number, kind: string | null) => ({ type: 'Feature',
        properties: { class: kind }, geometry: { type: 'LineString', coordinates: [coordinate(x0, y0), coordinate(x1, y1)] } });
    const obstacles = [point(200, 400, { structureType: 'CRANE', heightM: 0 }),
        point(410, 420, { structureType: 'power_tower', heightM: 0 }),
        point(600, 220, { structureType: 'UTILITY POLE', heightM: 100 })];
    const roads = [line(0, 405, 800, 405, 'residential'), line(100, 250, 700, 600, 'footway'),
        line(605, 0, 605, 800, null), line(80, 215, 720, 215, 'steps')];
    for (const role of ['obstacles', 'roads'] as const) {
        const features = role === 'obstacles' ? obstacles : roads;
        const { work, region } = await setup(t, role, features, role === 'obstacles' ? 'mapped' : undefined);
        if (role === 'roads') region.sources.roads[0].roadSource = 'typed';
        const terrain = Uint8Array.from({ length: grid.width * grid.height }, (_, i) => Number(i % 3 !== 0));
        const actual = await readGlideHazardMasks(region, grid, work, terrain);

        // Independent oracle: rasterize all features twice without partitioning.
        const reference = path.join(work, 'reference.geojson'), database = path.join(work, 'reference.gpkg');
        await fs.writeFile(reference, JSON.stringify({ type: 'FeatureCollection', features: features.map(feature => {
            const buffers = [false, true].map(fallback => {
                if (role === 'obstacles') return hazardBuffer(role, feature.properties, 'mapped', fallback);
                const kind = (feature.properties as { class: string | null }).class;
                return kind === 'footway' ? (fallback ? 0 : GLIDE_RULES.pathClearanceM * GLIDE_RULES.metricMargin) :
                    kind === 'steps' ? GLIDE_RULES.pathClearanceM * GLIDE_RULES.metricMargin : hazardBuffer(role);
            });
            return { ...feature, properties: { preferredM: buffers[0], fallbackM: buffers[1] } };
        }) }));
        await gdalCommand('ogr2ogr', ['-f', 'GPKG', '-nln', 'reference', '-t_srs', grid.srs, database, reference]);
        const expected: Uint8Array[] = [];
        for (const column of ['preferredM', 'fallbackM']) {
            const raster = path.join(work, `${column}.bin`);
            await gdalCommand('gdal_rasterize', ['-q', '-of', 'ENVI', '-ot', 'Byte', '-init', '0', '-dialect', 'SQLite',
                '-sql', `SELECT CASE WHEN ${column}=0 THEN geom ELSE ST_Buffer(geom,${column}) END AS geom FROM reference`,
                '-burn', '1', '-at', '-a_srs', grid.srs, '-te', ...grid.extent.map(String),
                '-ts', String(grid.width), String(grid.height), database, raster]);
            expected.push(Uint8Array.from(await fs.readFile(raster)));
        }
        assert.deepEqual(actual.preferred, expected[0], `${role}: preferred mask`);
        assert.deepEqual(actual.fallback, expected[1], `${role}: fallback mask`);
        assert.deepEqual(actual.obstacleFallback, Uint8Array.from(expected[0], (v, i) => Number(role === 'obstacles' && v && !expected[1][i])));
        assert.ok(actual.buildingFallback.every(v => v === 0));
        const removed = expected[1].reduce((sum, value, i) => sum + Number(value && terrain[i]), 0);
        assert.deepEqual(actual.losses, [{ source: 'hazard fixture', cells: removed }]);
    }
});
