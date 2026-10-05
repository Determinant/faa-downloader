import assert from 'node:assert/strict';
import test from 'node:test';
import { findGlideCorridors, glideTerrainClear, glideCoverClear, glideLongComponents, glideTerrainBands } from '../lib/glide-analysis.ts';
import { GLIDE_RULES, containsBounds, expandBounds, lengthTier, type Bounds, type GlideGrid } from '../lib/glide-model.ts';
import { hazardBuffer, hazardQueryBounds, buildingBuffers, type GlideSurface } from '../lib/glide-raster.ts';

function field(lengthCells = 300, widthCells = 40): { grid: GlideGrid; surface: GlideSurface } {
    const width = 400, height = 140, cells = width * height;
    const grid: GlideGrid = { width, height, cell: 10, west: 0, north: 1400,
        bounds: [0, 0, 0.04, 0.02], extent: [0, 0, 4000, 1400], srs: '',
        coordinate: (x, y) => [x * 10 / 111195, (height - y) * 10 / 111195] };
    const surface: GlideSurface = { known: new Uint8Array(cells).fill(1),
        elevationMin: new Float32Array(cells).fill(100), elevationMax: new Float32Array(cells).fill(100),
        cover: new Uint8Array(cells).fill(1), cropDependent: new Uint8Array(cells), hazards: new Uint8Array(cells).fill(1) };
    const x0 = Math.floor((width - lengthCells) / 2), y0 = Math.floor((height - widthCells) / 2);
    for (let y = y0; y < y0 + widthCells; y++) for (let x = x0; x < x0 + lengthCells; x++) surface.hazards[y * width + x] = 0;
    return { grid, surface };
}

test('length tiers never promote a short corridor', () => {
    assert.equal(lengthTier(599), 0);
    assert.equal(lengthTier(600), 1);
    assert.equal(lengthTier(1999), 1);
    assert.equal(lengthTier(2000), 2);
});

test('length precheck rejects disconnected short patches while retaining both landing tiers', () => {
    const width = 200, height = 200, clear = new Uint8Array(width * height);
    // The overall extent is long, but no individual connected patch is.
    for (const y0 of [10, 160]) for (const x0 of [10, 160]) {
        for (let y = y0; y < y0 + 10; y++) for (let x = x0; x < x0 + 10; x++) clear[y * width + x] = 1;
    }
    assert.equal(glideLongComponents(clear, width, height), false);
    assert.ok(clear.every(value => value === 0));
    for (const length of [150, 300]) {
        const { surface, grid } = field(length);
        const centers = glideTerrainClear(surface, grid.width, grid.height, glideCoverClear(surface, grid.width, grid.height)), before = centers.slice();
        assert.equal(glideLongComponents(centers, grid.width, grid.height), true);
        assert.deepEqual(centers, before);
    }
    // Diagonal sample neighbors belong to the same component.
    for (let i = 0; i < 110; i++) clear[i * width + i] = 1;
    assert.equal(glideLongComponents(clear, width, height), true);
});

test('tiers measure screened length without hidden end reserves; both use whole-width clearance', () => {
    const long = field(), short = field(55), narrow = field(300, 6);
    const preferred = findGlideCorridors(long.surface, long.grid);
    const emergency = findGlideCorridors(short.surface, short.grid);
    assert.ok(preferred.some(record => record[7] === 2));
    assert.ok(emergency.length > 0);
    assert.ok(emergency.every(record => record[7] === 1 && record[5] >= 1500 && record[5] < 2000));
    assert.ok(preferred.every(record => record[4] === GLIDE_RULES.widthFt && record[6] === 100));
    assert.deepEqual(findGlideCorridors(narrow.surface, narrow.grid), []);
});

test('a cross-field wire or missing strip splits runs instead of bridging them', () => {
    for (const kind of ['wire', 'unknown'] as const) {
        const { surface, grid } = field(110, 24);
        for (let y = 0; y < grid.height; y++) {
            const i = y * grid.width + 200;
            if (kind === 'wire') surface.hazards[i] = 1;
            else surface.known[i] = 0;
        }
        const records = findGlideCorridors(surface, grid);
        assert.ok(records.length > 0);
        const longitude = 200 * 10 / 111195 * 1e6;
        assert.ok(records.every(record => Math.max(record[0], record[2]) < longitude || Math.min(record[0], record[2]) > longitude));
        assert.ok(records.every(record => record[7] === 1));
    }
});

test('rejected native cover, NoData and uneven elevation cannot qualify', () => {
    for (const reject of [
        (s: GlideSurface) => s.cover.fill(0),
        (s: GlideSurface) => s.known.fill(0),
        (s: GlideSurface) => s.elevationMax.fill(NaN),
        (s: GlideSurface) => s.elevationMax.fill(101),
    ]) {
        const { surface, grid } = field();
        reject(surface);
        assert.deepEqual(findGlideCorridors(surface, grid), []);
    }
});

test('zero cover margin reuses screened clearance without trusting rejected cover in supplied masks', () => {
    const { surface, grid } = field(120, 8);
    const screenedGround = Uint8Array.from(surface.hazards, value => Number(!value));
    const selected = { ...surface, screenedGround, coverClearanceM: 0 };
    const records = findGlideCorridors(selected, grid);
    assert.ok(records.length > 0);
    assert.deepEqual(records, findGlideCorridors({ ...selected, coverClearanceM: GLIDE_RULES.coverBoundaryClearanceM }, grid),
        'extra clearance changes nothing when all surrounding cover is known and eligible');
    for (const missing of ['cover', 'known'] as const) {
        assert.deepEqual(findGlideCorridors({ ...selected, [missing]: new Uint8Array(surface.cover.length) }, grid), [],
            `a supplied fit mask cannot override rejected ${missing}`);
    }
});

test('guyed/unknown structures and positional uncertainty enlarge obstacle exclusions', () => {
    assert.ok(hazardBuffer('obstacles', { structureType: 'TOWER', horizontalAccuracyCode: 1 }) > 610);
    assert.ok(hazardBuffer('obstacles', {}) > 2400);
    assert.ok(hazardBuffer('obstacles', { structureType: 'CRANE', heightAglFt: 1000, horizontalAccuracyCode: 1 }) > 450);
    assert.equal(hazardBuffer('obstacles', { horizontalAccuracyM: null }), hazardBuffer('obstacles', {}));
    assert.throws(() => hazardBuffer('obstacles', { heightM: 6000 }), /10852 m.*10000 m/);
});

test('mapped utility supports do not inherit FAA unknown-position or generic mast clearances', () => {
    for (const structureType of ['power_tower', 'water_tower', 'pylon']) {
        const properties = { structureType, heightM: 0 };
        const mapped = hazardBuffer('obstacles', properties, 'mapped');
        assert.ok(mapped > 100 && mapped < 150, structureType);
        assert.ok(hazardBuffer('obstacles', properties) > 1852, 'unidentified source keeps the fallback');
        assert.ok(hazardBuffer('obstacles', properties, 'faa-dof') > 1852);
    }
    for (const structureType of ['tower', 'mast', 'communication_tower', 'unknown']) {
        assert.ok(hazardBuffer('obstacles', { structureType }, 'mapped') > 610, structureType);
    }
    assert.ok(hazardBuffer('obstacles', { structureType: 'power_tower', heightM: 200 }, 'mapped') > 330);
    assert.ok(hazardBuffer('obstacles', { structureType: 'crane' }, 'mapped') > 180);
});

test('explicit obstacle accuracy takes precedence over the mapped-source fallback', () => {
    for (const accuracy of [{ horizontalAccuracyCode: '6' }, { horizontalAccuracyCode: '9' },
        { horizontalAccuracyCode: 'invalid' }, { horizontalAccuracyM: 400 }]) {
        const properties = { structureType: 'power_tower', ...accuracy };
        assert.equal(hazardBuffer('obstacles', properties, 'mapped'), hazardBuffer('obstacles', properties, 'faa-dof'));
    }
    assert.throws(() => hazardBuffer('obstacles', { horizontalAccuracyM: -1 }, 'mapped'), /Invalid obstacle/);
});

test('identified control buildings, tanks, signs and lighting do not inherit radio-mast guy-wire buffers', () => {
    for (const structureType of ['CTRL TWR', 'control_tower', 'TANK', 'storage_tank', 'SIGN', 'lighting', 'parking']) {
        const properties = { structureType, heightAglFt: 30, horizontalAccuracyCode: '4' };
        assert.equal(hazardBuffer('obstacles', properties, 'faa-dof'), (100 + 250 * 0.3048) * GLIDE_RULES.metricMargin);
        assert.equal(hazardBuffer('obstacles', { ...properties, heightAglFt: 1000 }, 'faa-dof'),
            (1000 * 0.3048 * 1.5 + 250 * 0.3048) * GLIDE_RULES.metricMargin);
    }
    for (const structureType of ['TOWER', 'mast', 'mobile_phone_tower', 'communication_tower', 'UNKNOWN', '']) {
        assert.equal(hazardBuffer('obstacles', { structureType, heightM: 10 }, 'mapped'),
            (610 + GLIDE_RULES.mappedPositionAllowanceM) * GLIDE_RULES.metricMargin);
    }
});

test('FAA utility-pole labels use pole clearance while retaining reported position uncertainty and height', () => {
    // KMMH 06-317130: 43 ft AGL, FAA horizontal accuracy 4 (250 ft).
    const properties = { structureType: 'UTILITY POLE', heightAglFt: 43, horizontalAccuracyCode: '4' };
    const expected = (100 + 250 * 0.3048) * GLIDE_RULES.metricMargin;
    for (const structureType of ['UTILITY POLE', 'utility_pole', ' Utility-Pole ']) {
        assert.equal(hazardBuffer('obstacles', { ...properties, structureType }, 'faa-dof'), expected);
    }
    assert.equal(hazardBuffer('obstacles', properties, 'faa-dof'),
        hazardBuffer('obstacles', { ...properties, structureType: 'POLE' }, 'faa-dof'));
    assert.equal(hazardBuffer('obstacles', { ...properties, heightAglFt: 1000 }, 'faa-dof'),
        (1000 * 0.3048 * 1.5 + 250 * 0.3048) * GLIDE_RULES.metricMargin);
    assert.ok(hazardBuffer('obstacles', { ...properties, horizontalAccuracyCode: '9' }, 'faa-dof') > 1852);
    assert.ok(hazardBuffer('obstacles', { ...properties, structureType: 'UNKNOWN UTILITY STRUCTURE' }, 'faa-dof') > 690);
});

test('high tethered balloons retain their full buffer within acquired coverage at region edges', () => {
    // The real record that stopped the Florida Keys build, plus the tallest
    // record in the acquired national DOF snapshot (Parguera, 14,947 ft AGL).
    for (const heightAglFt of [13997, 14947]) {
        const buffer = hazardBuffer('obstacles', { structureType: 'BALLOON', heightAglFt, horizontalAccuracyCode: '9' });
        assert.ok(buffer > 8000 && buffer < 10000);
        const region: Bounds = [-82, 24, -81, 25], chunk: Bounds = [-82, 24, -81.875, 24.125];
        const acquired = expandBounds(region, GLIDE_RULES.inventoryHaloM), query = hazardQueryBounds(chunk, 'obstacles');
        assert.ok(containsBounds(acquired, query));
        assert.ok(containsBounds(query, expandBounds(chunk, GLIDE_RULES.analysisHaloM + buffer + 50)));
        assert.ok(containsBounds(query, hazardQueryBounds(chunk, 'buildings')));
        assert.ok(hazardQueryBounds(chunk, 'buildings')[0] > query[0]);
    }
});


test('purple admits rolling terrain but preserves green, native breaks, unknown cells and hazards', () => {
    const { surface, grid } = field(); surface.hazards.fill(0);
    const center = 70 * grid.width + 200;
    for (const [grade, expected] of [[0.015, 1], [0.025, 2], [0.05, 2], [0.08, 3], [0.13, 0]]) {
        for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
            const i = y * grid.width + x, z = 100 + x * grid.cell * grade;
            surface.elevationMin[i] = z - 0.1; surface.elevationMax[i] = z + 0.1;
        }
        const bands = () => glideTerrainBands(surface, grid.width, grid.height, surface.cover);
        assert.equal(bands()[center], expected, `${grade * 100}% grade`);
        if (grade === 0.025) {
            surface.elevationMin[center] += 0.5; surface.elevationMax[center] += 0.5;
            assert.equal(bands()[center], 2, 'ordinary undulation is not a blanket purple veto');
            surface.elevationMin[center] += 4; surface.elevationMax[center] += 4;
            assert.equal(bands()[center], 0, 'a major break cannot be averaged away');
            surface.elevationMin[center] -= 4.5;
            assert.equal(bands()[center], 0, 'native within-cell extrema still reject the break');
            surface.elevationMax[center] -= 4.5; surface.known[center + 1] = 0;
            assert.equal(bands()[center], 0, 'unknown neighbors cannot approve the plane');
            surface.known[center + 1] = 1; surface.hazards[center] = 1;
            assert.equal(bands()[center], 0, 'a mapped hazard cannot become fallback ground');
            surface.hazards[center] = 0;
        }
    }
});

test('identified building and barrier setbacks can narrow; untyped sources and wires retain margins', () => {
    assert.deepEqual(buildingBuffers({ buildingSource: 'footprint' }), [30.3, 20.2]);
    assert.deepEqual(buildingBuffers({ buildingSource: 'ground-barrier' }), [60.6, 10.1]);
    assert.deepEqual(buildingBuffers({}), [60.6, 60.6]);
    assert.equal(hazardBuffer('powerlines'), 60.6);
});

test('actual strip geometry retains a 70 m hazard-free strip and a 90 m field with cover setbacks', () => {
    const narrow = field(75, 7);
    assert.ok(findGlideCorridors(narrow.surface, narrow.grid).some(q => q[7] === 2), '200 ft fits without extra isotropic end/side erosion');
    const edged = field(75, 9);
    edged.surface.cover = Uint8Array.from(edged.surface.hazards, value => Number(!value));
    assert.ok(findGlideCorridors(edged.surface, edged.grid).some(q => q[7] === 2), '10 m cover clearance is applied once around the full strip');
});

test('principal-direction search finds a narrow oblique field without crossing its boundary', () => {
    const {grid,surface} = field();
    surface.hazards.fill(1);
    const theta = 17 * Math.PI / 180, dx = Math.cos(theta), dy = Math.sin(theta);
    for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
        // Require the entire raster cell within an 850 × 100 m rectangle.
        if ([[x,y],[x+1,y],[x,y+1],[x+1,y+1]].every(([xx,yy]) =>
            Math.abs((xx-200)*dx+(yy-70)*dy) < 42.5 && Math.abs(-(xx-200)*dy+(yy-70)*dx) < 5)) surface.hazards[y*grid.width+x] = 0;
    }
    const records = findGlideCorridors(surface,grid);
    assert.ok(records.some(q=>q[7]===2));
    for(const q of records) assert.ok(q[5] <= 850 / 0.3048);
});

test('oriented rectangle checks distinguish empty bounding-box corners from intersecting hazards', async () => {
    const { glideRectangleChecker } = await import('../lib/glide-fit.ts');
    const clear = new Uint8Array(40 * 40).fill(1), d = Math.SQRT1_2;
    clear[27 * 40 + 12] = 0;
    assert.equal(glideRectangleChecker(clear, 40, 40)(20, 20, d, d, 10, 2), true);
    clear[21 * 40 + 21] = 0;
    assert.equal(glideRectangleChecker(clear, 40, 40)(20, 20, d, d, 10, 2), false);
    assert.equal(glideRectangleChecker(clear, 40, 40)(1, 1, d, d, 10, 2), false);
});

test('purple retains explicit position uncertainty and potentially guyed mast protection', () => {
    for (const source of ['mapped', 'faa-dof'] as const) {
        for (const structureType of ['mast', 'TOWER', 'communication_tower', 'CRANE', 'unknown']) {
            const properties = { structureType, heightM: 40, horizontalAccuracyM: 400 };
            assert.equal(hazardBuffer('obstacles', properties, source, true), hazardBuffer('obstacles', properties, source));
        }
        for (const accuracy of [{ horizontalAccuracyM: 400 }, { horizontalAccuracyCode: 7 }, { horizontalAccuracyCode: 9 }]) {
            const buffer = hazardBuffer('obstacles', { structureType: 'POLE', heightM: 10, ...accuracy }, source, true);
            const uncertainty = 'horizontalAccuracyM' in accuracy ? 400 : accuracy.horizontalAccuracyCode === 7 ? 926 : 1852;
            assert.equal(buffer, (30 + uncertainty) * GLIDE_RULES.metricMargin);
        }
    }
    assert.equal(hazardBuffer('obstacles', { structureType: 'POLE' }, undefined, true), hazardBuffer('obstacles', { structureType: 'POLE' }));
});

test('ordinary FAA and mapped structures do not inherit mast buffers, while wires and unknown towers do', () => {
    for (const structureType of ['FENCE', 'SOLAR PANELS', 'solar_panel', 'T-L TWR', 'wind_turbine', 'BLDG-TWR', 'BRIDGE']) {
        const p = { structureType, heightAglFt: 10, horizontalAccuracyCode: '1' };
        assert.equal(hazardBuffer('obstacles', p, 'faa-dof', true), (30 + 20 * .3048) * GLIDE_RULES.metricMargin, structureType);
        assert.equal(hazardBuffer('obstacles', p, 'faa-dof'), (100 + 20 * .3048) * GLIDE_RULES.metricMargin, structureType);
    }
    for (const structureType of ['mast', 'TOWER', 'NAVAID', 'CATENARY', 'unknown']) {
        assert.ok(hazardBuffer('obstacles', { structureType, heightM: 10 }, 'mapped', true) > 610, structureType);
    }
    assert.equal(hazardBuffer('powerlines'), 60.6);
});

test('fit grade reports along and cross components without changing flatness screening', () => {
    const { grid, surface } = field();
    for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
        surface.elevationMin[y * grid.width + x] = surface.elevationMax[y * grid.width + x] = 100 + x * .1 + y * .05;
    }
    const [q] = findGlideCorridors(surface, grid);
    assert.ok(q);
    const angle = Math.atan2(-(q[3] - q[1]), q[2] - q[0]);
    assert.ok(Math.abs(q[8]! - 1000 * (.01 * Math.cos(angle) + .005 * Math.sin(angle))) <= 1);
    assert.ok(Math.abs(q[9]! - 1000 * (-.01 * Math.sin(angle) + .005 * Math.cos(angle))) <= 1);
});
