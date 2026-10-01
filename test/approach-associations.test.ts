import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { associateApproachCharts, publishedApproachAssociations } from '../lib/approach-associations.ts';
const read = async (name: string) => JSON.parse(await fs.readFile(new URL(name, import.meta.url), 'utf8'));
const [catalog, routes, reviews] = await Promise.all([
    read('./fixtures/approach-association-charts.json'), read('./fixtures/approach-association-routes.json'),
    read('../data/approach-associations/2026-09-03.json'),
]);
const sources = { ...reviews.sources, terminalJsonSha256: 'a'.repeat(64) };

test('version 2 and shared-fixes version 3 navigation publish source-bound plate associations', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-plate-associations-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const terminal = { metadata: { effectiveDate: catalog.effectiveDate }, approaches: routes,
        sources: [{ group: 'CIFP', recordFile: { sha256: reviews.sources.cifpSha256 } }] };
    const body = JSON.stringify(terminal);
    const sha256 = createHash('sha256').update(body).digest('hex');
    const file = `terminal-procedures.${sha256}.json`;
    await fs.writeFile(path.join(directory, file), body);
    for (const schemaVersion of [2, 3]) {
        await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ schemaVersion,
            effectiveDate: catalog.effectiveDate,
            products: [{ id: 'terminal-procedures', file, sha256, jsonSha256: sha256 }] }));
        const result = await publishedApproachAssociations(catalog, directory);
        assert.ok(result, `navigation schema ${schemaVersion} must retain plate associations`);
        assert.equal(result.sources.terminalJsonSha256, sha256);
        assert.deepEqual(result.records, associateApproachCharts(catalog, routes,
            { ...sources, terminalJsonSha256: sha256 }, reviews.entries).records);
    }
    await fs.writeFile(path.join(directory, file), body.replace('metadata', 'changedMetadata'));
    await assert.rejects(publishedApproachAssociations(catalog, directory), /Navigation identity mismatch/);
});

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
