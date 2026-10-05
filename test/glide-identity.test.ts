import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildFingerprint, writeCachedJson } from '../lib/build-cache.ts';
import { GLIDE_ANALYSIS_REVISION, glideAnalysisIdentity, glideAnalysisProfiles, glideAnalysisFingerprints,
    glideSourceIdentity, readGlideAnalysis } from '../lib/glide-identity.ts';
import { GLIDE_VERSION, GLIDE_RULES, ALL_RASTER_ROLES, OPTIONAL_VECTOR_ROLES, VECTOR_ROLES, glideChunks, type ResolvedRegion } from '../lib/glide-model.ts';

function fixtureRegion(): ResolvedRegion {
    return { id: 'fixture', bounds: [-98, 26, -97.99, 26.01], coverageBounds: [-99, 25, -97, 27],
        sources: Object.fromEntries([...ALL_RASTER_ROLES, ...OPTIONAL_VECTOR_ROLES, ...VECTOR_ROLES].map(role =>
            [role, [{ name: role, date: '2026-01-01', attribution: 'test', file: '/fixture', sha256: 'a'.repeat(64), bytes: 100 }]])) as ResolvedRegion['sources'] };
}

test('analysis identity is an explicit revision, independent of source file contents', () => {
    assert.equal(GLIDE_VERSION, 1);
    assert.equal(glideAnalysisIdentity(), buildFingerprint({ version: GLIDE_VERSION, analysisRevision: GLIDE_ANALYSIS_REVISION }));
});

test('known run checkpoints migrate only with exact inputs and verified bytes', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-identity-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const file = path.join(root, 'chunk.json'), receiptFile = `${file}.build.json`;
    const region = fixtureRegion(), [chunk] = glideChunks(region), versions = ['GDAL fixture'];
    const { areaSimplificationM: _, ...rules } = GLIDE_RULES;
    const oldImplementation = 'cd4afcbc8f991234b98e8a43cb16343d21963f53818cfe9a6bb5e9f236c051e9';
    const keyFor = (regionFingerprint: string, ground: boolean) => buildFingerprint(ground ?
        { groundFingerprint: regionFingerprint, chunk } : { regionFingerprint, chunk });
    const oldKey = (ground: boolean, legacyDates: boolean, implementation = oldImplementation) => keyFor(buildFingerprint({
        version: 1, implementation, rules, versions, ...glideSourceIdentity(region, ground, legacyDates) }), ground);
    const result = { areas: [], screening: null };
    for (const ground of [false, true]) for (const legacyDates of [false, true]) {
        const keys = glideAnalysisFingerprints(region, versions, ground).map(key => keyFor(key, ground));
        await writeCachedJson(file, receiptFile, oldKey(ground, legacyDates), result);
        const original = await fs.readFile(file), stat = await fs.stat(file);
        assert.deepEqual(await readGlideAnalysis(file, keys), result);
        assert.deepEqual(await fs.readFile(file), original);
        assert.equal((await fs.stat(file)).mtimeMs, stat.mtimeMs, 'adoption must not rewrite analysis');
        assert.equal(JSON.parse(await fs.readFile(receiptFile, 'utf8')).inputSha256, keys[0]);
        assert.deepEqual(await readGlideAnalysis(file, keys), result, 'subsequent resume uses the current receipt');
    }
    const keys = glideAnalysisFingerprints(region, versions).map(key => keyFor(key, false));
    for (const mutate of [
        (r: ResolvedRegion) => { r.sources.obstacles[0].sha256 = 'b'.repeat(64); },
        (r: ResolvedRegion) => { r.sources.buildings[0].buildingSource = 'footprint'; },
        (r: ResolvedRegion) => { r.sources.landcover[0].date = '2026-02-01'; },
        (r: ResolvedRegion) => { r.coverageBounds[0] -= 0.1; },
    ]) {
        await writeCachedJson(file, receiptFile, oldKey(false, false), result);
        const changed = structuredClone(region);
        mutate(changed);
        assert.equal(await readGlideAnalysis(file, glideAnalysisFingerprints(changed, versions).map(key => keyFor(key, false))), undefined);
    }
    assert.equal(await readGlideAnalysis(file, glideAnalysisFingerprints(region, ['different GDAL']).map(key => keyFor(key, false))), undefined);
    await writeCachedJson(file, receiptFile, oldKey(false, false, 'f'.repeat(64)), result);
    assert.equal(await readGlideAnalysis(file, keys), undefined, 'unrecognized old algorithms cannot migrate');
    await writeCachedJson(file, receiptFile, oldKey(false, false), result);
    const originalReceipt = await fs.readFile(receiptFile, 'utf8');
    await fs.writeFile(file, JSON.stringify({ areas: ['corrupt'], screening: null }));
    assert.equal(await readGlideAnalysis(file, keys), undefined, 'legacy output checksum is required');
    assert.equal(await fs.readFile(receiptFile, 'utf8'), originalReceipt, 'corrupt checkpoints are not promoted');
});

test('policy changes disable migration from the known run', () => {
    assert.equal(glideAnalysisProfiles().length, 2);
    const mutableRules = GLIDE_RULES as unknown as Record<string, unknown>, saved = GLIDE_RULES.areaSimplificationM;
    try {
        mutableRules.areaSimplificationM = saved + 1;
        assert.equal(glideAnalysisProfiles().length, 1);
    } finally { mutableRules.areaSimplificationM = saved; }
});

test('analysis ignores unrelated release dates but preserves cover recency and every source digest', () => {
    const roles = [...ALL_RASTER_ROLES, ...OPTIONAL_VECTOR_ROLES, ...VECTOR_ROLES];
    const region: ResolvedRegion = { id: 'fixture', bounds: [-98, 26, -97, 27], coverageBounds: [-99, 25, -96, 28],
        sources: Object.fromEntries(roles.map(role => [role, [{ name: role, date: '2025-01-01', attribution: 'test',
            file: '/fixture', sha256: 'a'.repeat(64), bytes: 100 }]])) as ResolvedRegion['sources'] };
    const original = buildFingerprint(glideSourceIdentity(region));
    for (const role of roles) {
        const changed = structuredClone(region);
        changed.sources[role]![0].date = '2026-01-01';
        assert.equal(buildFingerprint(glideSourceIdentity(changed)) !== original,
            ['landcover', 'canopy', 'fineLandcover', 'ground'].includes(role), role);
        changed.sources[role]![0].sha256 = 'b'.repeat(64);
        assert.notEqual(buildFingerprint(glideSourceIdentity(changed)), original, `${role} content must invalidate analysis`);
    }
    const changed = structuredClone(region);
    changed.sources.obstacles[0].date = '2026-01-01';
    assert.notEqual(buildFingerprint(glideSourceIdentity(changed, false, true)),
        buildFingerprint(glideSourceIdentity(region, false, true)), 'legacy adoption still requires the exact old identity');
    assert.deepEqual(glideSourceIdentity(changed, true), glideSourceIdentity(region, true));
});
