import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultGlideAreas, parseGlideBounds } from '../lib/glide-defaults.ts';
import { containsBounds, expandBounds, GLIDE_RULES } from '../lib/glide-model.ts';
import { parseGlideCoverage } from '../lib/glide-raster-download.ts';

test('automatic footprint has unique bounded CONUS regions and needs no source file', async () => {
    const areas = await defaultGlideAreas();
    assert.ok(areas.length > 500);
    assert.equal(new Set(areas.map(area => area.id)).size, areas.length);
    for (const area of areas) {
        assert.ok(area.bounds[0] >= -125 && area.bounds[2] <= -66 && area.bounds[1] >= 24 && area.bounds[3] <= 50);
        assert.ok(containsBounds(area.coverageBounds, expandBounds(area.bounds, GLIDE_RULES.inventoryHaloM)));
    }
});

test('bbox limits ownership exactly across degree boundaries', async () => {
    const bounds = parseGlideBounds('-122.01,37.99,-121.99,38.01');
    const areas = await defaultGlideAreas(bounds);
    assert.equal(areas.length, 4);
    const covered = areas.reduce((sum, area) => {
        assert.ok(containsBounds(bounds, area.bounds));
        return sum + (area.bounds[2] - area.bounds[0]) * (area.bounds[3] - area.bounds[1]);
    }, 0);
    assert.ok(Math.abs(covered - (bounds[2] - bounds[0]) * (bounds[3] - bounds[1])) < 1e-12);
    for (const invalid of ['', '0,0,1,1', '-122,38,-123,39', '-122,, -121,39', '-122,38,-121,NaN']) {
        assert.throws(() => parseGlideBounds(invalid), /bbox/);
    }
});

const coverage = `<CoverageDescription xmlns="http://www.opengis.net/wcs" xmlns:gml="http://www.opengis.net/gml">
  <CoverageOffering><name>landcover</name><domainSet><spatialDomain>
    <gml:RectifiedGrid srsName="EPSG:5070"><gml:limits><gml:GridEnvelope>
    <gml:low>0 0</gml:low><gml:high>159999 104999</gml:high></gml:GridEnvelope></gml:limits>
    <gml:origin><gml:pos>-2415570 3314790</gml:pos></gml:origin>
    <gml:offsetVector>30 0</gml:offsetVector><gml:offsetVector>0 -30</gml:offsetVector></gml:RectifiedGrid>
  </spatialDomain><temporalDomain><gml:timePosition>2025-01-01T00:00:00.000Z</gml:timePosition>
    <gml:timePosition>2024-01-01T00:00:00.000Z</gml:timePosition></temporalDomain></domainSet></CoverageOffering>
</CoverageDescription>`;

test('MRLC discovery chooses the latest available year and rejects unexpected native grids', () => {
    const service = parseGlideCoverage(coverage, 'https://example.test/wcs');
    assert.equal(service.time, '2025-01-01T00:00:00.000Z');
    assert.deepEqual(service.origin, [-2415570, 3314790]);
    assert.deepEqual(service.extent, [-2415585, 164805, 2384415, 3314805]);
    assert.throws(() => parseGlideCoverage(coverage.replace('159999 104999', '-1 104999'), service.endpoint), /native grid/);
    assert.throws(() => parseGlideCoverage(coverage.replace('<gml:low>0 0</gml:low>', ''), service.endpoint), /native grid/);
    assert.throws(() => parseGlideCoverage(coverage.replace('30 0', '90 0'), service.endpoint), /native grid/);
    assert.throws(() => parseGlideCoverage(coverage.replace('EPSG:5070', 'EPSG:4326'), service.endpoint), /native grid/);
    const shrub = parseGlideCoverage(coverage.replace('EPSG:5070', 'EPSG:3857'), service.endpoint, 'EPSG:3857');
    assert.equal(shrub.srs, 'EPSG:3857', 'supplemental grids explicitly declare their published projection');
    assert.throws(() => parseGlideCoverage(coverage, service.endpoint, 'EPSG:3857'), /native grid/);
    assert.throws(() => parseGlideCoverage('<ExceptionReport>Unavailable</ExceptionReport>', service.endpoint), /rejected/);
});
