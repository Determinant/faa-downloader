import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { CHART_DEFINITIONS } from '../lib/chart-definitions.ts';
import { chartCutlineForFilename } from '../lib/chart-tiler.ts';
import { IFR_NEATLINES, IFR_NEATLINE_PROVENANCE } from '../lib/ifr-neatlines.ts';
import { sourcePixel } from '../tools/check-ifr-neatlines.ts';

function contains(ring: number[][], [x, y]: number[]): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

test('reviewed chart seams retain source imagery and preserve actual FAA frame separations', async () => {
    const reference: { probes: Array<{ label: string; kind: string; coordinate: number[];
        projectedCoordinate?: number[]; covered: boolean }> } = JSON.parse(await fs.readFile(
        new URL('./fixtures/chart-seams-2026-09-03.json', import.meta.url), 'utf8'));
    const charts = Object.entries(CHART_DEFINITIONS).map(([file, definition]) => ({
        kind: definition.kind,
        ring: chartCutlineForFilename(file)!.wkt.slice('POLYGON (('.length, -2)
            .split(', ').map(pair => pair.split(' ').map(Number))
    }));
    for (const probe of reference.probes) {
        const covered = charts.some(chart => chart.kind === probe.kind &&
            contains(chart.ring, probe.projectedCoordinate ?? probe.coordinate));
        assert.equal(covered, probe.covered, `${probe.label} at ${probe.coordinate.join(', ')}`);
    }
});

test('every IFR sheet uses a measured frame while VFR retains its reviewed boundaries', () => {
    const entries = Object.entries(CHART_DEFINITIONS);
    const ifr = entries.filter(([, chart]) => chart.kind.startsWith('ifr-'));
    assert.equal(ifr.length, 49);
    assert.deepEqual(Object.keys(IFR_NEATLINES).sort(), ifr.map(([file]) => file).sort());
    for (const [file, chart] of ifr) {
        assert.equal(chart.provenance, IFR_NEATLINE_PROVENANCE, file);
        const reference = IFR_NEATLINES[file];
        const [left, top, right, bottom] = reference.pixelBounds;
        assert.ok(left >= 0 && top >= 0 && right > left && bottom > top &&
            right <= reference.sourceSize[0] && bottom <= reference.sourceSize[1], file);
        assert.match(reference.sourceSha256, /^[a-f0-9]{64}$/, file);
    }
    assert.ok(entries.filter(([, chart]) => chart.kind.startsWith('vfr-'))
        .every(([, chart]) => chart.provenance !== IFR_NEATLINE_PROVENANCE));
});

test('source-frame checks account for rotated FAA raster transforms', () => {
    // Independent L07 pixel/line control from the FAA 2026-09-03 GeoTIFF.
    const transform = [-2399194.67, 32.2885077, -2.78530596, -15888.8191, -2.77902566, -32.2768455];
    const point = sourcePixel([-1696848.762176346, -85293.70138405263], transform);
    assert.ok(Math.abs(point[0] - 21775.9513686) < 0.001);
    assert.ok(Math.abs(point[1] - 275.3972553) < 0.001);
    assert.throws(() => sourcePixel([0, 0], [0, 1, 1, 0, 1, 1]), /Invalid source transform/);
});
