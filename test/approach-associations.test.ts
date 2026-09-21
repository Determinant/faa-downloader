import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { associateApproachCharts } from '../lib/approach-associations.ts';
const read = async (name: string) => JSON.parse(await fs.readFile(new URL(name, import.meta.url), 'utf8'));
const [catalog, routes, reviews] = await Promise.all([
    read('./fixtures/approach-association-charts.json'), read('./fixtures/approach-association-routes.json'),
    read('../data/approach-associations/2026-09-03.json'),
]);
const sources = { ...reviews.sources, terminalJsonSha256: 'a'.repeat(64) };

test('publication accounts for every active chart and retains reviewed evidence and parallel choices', () => {
    const result = associateApproachCharts(catalog, routes, sources, reviews.entries);
    assert.equal(result.records.length, catalog.airports.flatMap(a => a.procedures).length);
    for (const review of reviews.entries) {
        const record = result.records.find(r => r.airport === review.airport && r.title === review.title)!;
        assert.equal(record.rule, 'reviewed');
        assert.deepEqual(record.routeIds, [review.routeId]);
        assert.deepEqual(record.evidence, review.evidence);
    }
    const parallel = result.records.find(r => r.airport === 'KBJC')!;
    assert.equal(parallel.status, 'ambiguous');
    assert.deepEqual(parallel.routeIds, ['KBJC:D30L', 'KBJC:D30R']);
    assert.equal(result.records.find(r => r.airport === 'KJFK' && r.title.includes('13L/R'))!.rule, 'parallel-equivalent');
});
test('wrong editions, changed chart identities, and missing route branches cannot reuse reviewed joins', () => {
    assert.throws(() => associateApproachCharts({ ...catalog, effectiveDate: '2026-10-01' }, routes, sources), /matching editions/);
    assert.throws(() => associateApproachCharts(catalog, routes, { ...sources, chartXmlSha256: 'b'.repeat(64) }), /source identities/);
    const changed = structuredClone(catalog);
    for (const a of changed.airports) for (const p of a.procedures) p.pdfUrl += '-changed';
    const result = associateApproachCharts(changed, routes, sources, reviews.entries);
    assert.equal(result.records.some(r => r.rule === 'reviewed'), false);
    const unavailable = associateApproachCharts(catalog, { ...routes, procedures: [] }, sources, reviews.entries);
    assert.ok(unavailable.records.every(r => r.status === 'unmatched' && r.routeIds.length === 0));
});
