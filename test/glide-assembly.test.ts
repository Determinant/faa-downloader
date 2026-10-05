import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import test, { type TestContext } from 'node:test';
import { buildFingerprint, matchesArtifacts, writeCachedJson } from '../lib/build-cache.ts';
import { GlideAssembly, GlideAssemblyFailures } from '../lib/glide-assembly.ts';
import { resumeGlideAssembly } from '../lib/glide-assembly-resume.ts';
import { GdalPool, gdalCli } from '../lib/gdal.ts';
import { GLIDE_RULES, GLIDE_VERSION, ALL_RASTER_ROLES, OPTIONAL_VECTOR_ROLES, RASTER_ROLES, VECTOR_ROLES,
    glideChunks, validateGlideInventory, type GlideLandingArea } from '../lib/glide-model.ts';
import { GLIDE_SHARD_POLICY, validateGlideShardPatches } from '../lib/glide-shards.ts';
import { glideAnalysisFingerprints } from '../lib/glide-identity.ts';
import { resolveGlideSources } from '../lib/glide-sources.ts';
import { buildGlide } from '../lib/glide.ts';
import { GlideChunkWorkers } from '../lib/glide-worker.ts';

const inputs = { implementation: 'unchanged-screening', versions: ['GDAL fixture'] };
const area = (i: number): GlideLandingArea => {
    const x = -98_000_000 + i * 3_037, y = 26_000_000;
    return [[x, y, x + 2_000, y, 60, 600, 123, 1, 0, 0], [[x - 100, y - 100, 2_200, 0, 0, 200, -2_200, 0]], 256];
};

async function fixture(t: TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-assembly-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const cache = path.join(root, 'cache'), work = path.join(root, 'work');
    await fs.mkdir(work);
    const id = '-98-26', records = Array.from({ length: 4 }, (_, i) => area(i));
    const text = records.map(record => JSON.stringify(record)).join('\n') + '\n';
    const spool = { file: path.join(work, '0--98-26.jsonl'), sha256: createHash('sha256').update(text).digest('hex') };
    await fs.writeFile(spool.file, text);
    // Seed the exact pre-existing merge cache format, independently of the new
    // assembler, to ensure a rollout never forces completed unions to rerun.
    const mergeKey = buildFingerprint({ packaging: GLIDE_SHARD_POLICY, version: GLIDE_VERSION,
        implementation: inputs.implementation, rules: GLIDE_RULES, versions: inputs.versions, patches: buildFingerprint(records) });
    const mergedFile = path.join(cache, 'area-shards', `${id}-0.json`);
    await writeCachedJson(mergedFile, `${mergedFile}.build.json`, mergeKey, records);
    const assembly = new GlideAssembly(cache, work, inputs);
    return { root, cache, work, id, records, spool, mergedFile, assembly };
}

test('existing merged polygons become persistent gzip/group checkpoints and survive work-directory removal', async t => {
    const f = await fixture(t), progress: string[] = [];
    const before = await fs.readFile(`${f.mergedFile}.build.json`, 'utf8');
    const first = await f.assembly.assemble(f.id, [f.spool], batch => progress.push(batch.source));
    assert.deepEqual(progress, ['merged']);
    assert.equal(first.mergedCached, 1);
    assert.equal(first.reusedGroup, false);
    assert.equal(await fs.readFile(`${f.mergedFile}.build.json`, 'utf8'), before);
    assert.ok(await matchesArtifacts(f.assembly.artifactDirectory, first.shards));
    const bytes = await fs.readFile(path.join(f.assembly.artifactDirectory, first.shards[0].file));
    assert.deepEqual(JSON.parse(gunzipSync(bytes).toString()), f.records);
    await fs.rm(f.work, { recursive: true });
    await fs.rm(path.dirname(f.mergedFile), { recursive: true });
    // The caller supplies hashes computed while recreating spools. Completed
    // groups must not need to open those polygons, read merge JSON, or recompress.
    const restarted = new GlideAssembly(f.cache, path.join(f.root, 'new-work'), inputs);
    const resumed = await restarted.assemble(f.id, [{ ...f.spool, file: '/absent/new-spool.jsonl' }],
        batch => progress.push(batch.source));
    assert.deepEqual(progress, ['merged', 'group']);
    assert.equal(resumed.reusedGroup, true);
    assert.equal(resumed.encodedCached, 1);
    assert.deepEqual(resumed.shards, first.shards);
});

test('an interrupted group resumes encoded batches even without a completed group or merge cache', async t => {
    const f = await fixture(t);
    const stopped = new Error('interrupted after committing the batch');
    await assert.rejects(f.assembly.assemble(f.id, [f.spool], () => { throw stopped; }), error => error === stopped);
    await assert.rejects(fs.stat(path.join(f.cache, 'assembly', 'groups', `${f.id}.json`)), { code: 'ENOENT' });
    await fs.rm(path.dirname(f.mergedFile), { recursive: true });
    const progress: string[] = [];
    const resumed = await new GlideAssembly(f.cache, f.work, inputs).assemble(f.id, [f.spool], batch => progress.push(batch.source));
    assert.deepEqual(progress, ['encoded']);
    assert.equal(resumed.reusedGroup, false);
    assert.equal(resumed.encodedCached, 1);
    assert.equal(resumed.mergedCached, 0);
    assert.ok(await matchesArtifacts(f.assembly.artifactDirectory, resumed.shards));
});

test('audit examines all failing batches and checkpoints later successes without marking the group complete', async t => {
    const f = await fixture(t), bad = area(0);
    bad[1] = [null as any]; // Broken input structure is not a geometry cleanup case.
    // Whitespace affects the stream's byte boundary without enlarging geometry.
    const padding = ' '.repeat(GLIDE_SHARD_POLICY.mergeRawBytes);
    const text = [bad, area(1), bad].map(record => JSON.stringify(record) + padding + '\n').join('');
    await fs.writeFile(f.spool.file, text);
    f.spool.sha256 = createHash('sha256').update(text).digest('hex');
    const failures: string[] = [], passed: string[] = [];
    await assert.rejects(f.assembly.assemble(f.id, [f.spool], batch => passed.push(batch.id), () => {}, {
        onBatchError: (id, error) => { failures.push(id); assert.ok(error instanceof TypeError); },
    }), error => error instanceof GlideAssemblyFailures && error.batches.length === 2);
    assert.deepEqual(failures, [`${f.id}-0`, `${f.id}-2`]);
    assert.deepEqual(passed, [`${f.id}-1`]);
    await assert.rejects(fs.stat(path.join(f.cache, 'assembly', 'groups', `${f.id}.json`)), { code: 'ENOENT' });
    const goodFile = path.join(f.cache, 'assembly', 'batches', `${f.id}-1.json`);
    const good = JSON.parse(await fs.readFile(goodFile, 'utf8'));
    assert.ok(await matchesArtifacts(f.assembly.artifactDirectory, good.shards));
    const sources: string[] = [];
    await assert.rejects(f.assembly.assemble(f.id, [f.spool], batch => sources.push(batch.source), () => {}, {
        onBatchError: () => {},
    }), GlideAssemblyFailures);
    assert.deepEqual(sources, ['encoded'], 'the successful middle batch survives another failed audit');
    assert.equal(await fs.readFile(f.spool.file, 'utf8'), text);
});

test('legacy merges of invalid originals are recomputed under the precision policy without rewriting analysis', async t => {
    const f = await fixture(t);
    const { merged, originals }: { merged: GlideLandingArea[]; originals: GlideLandingArea[] } =
        JSON.parse(await fs.readFile(new URL('fixtures/glide-quantization-fallback.json', import.meta.url), 'utf8'));
    const text = originals.map(record => JSON.stringify(record)).join('\n') + '\n';
    await fs.writeFile(f.spool.file, text);
    f.spool.sha256 = createHash('sha256').update(text).digest('hex');
    const key = buildFingerprint({ packaging: GLIDE_SHARD_POLICY, version: GLIDE_VERSION,
        implementation: inputs.implementation, rules: GLIDE_RULES, versions: inputs.versions, patches: buildFingerprint(originals) });
    await writeCachedJson(f.mergedFile, `${f.mergedFile}.build.json`, key, merged);
    const savedMerge = await fs.readFile(f.mergedFile, 'utf8'), savedReceipt = await fs.readFile(`${f.mergedFile}.build.json`, 'utf8');
    const progress: string[] = [], logs: string[] = [];
    const first = await f.assembly.assemble(f.id, [f.spool], batch => progress.push(batch.source), message => logs.push(message));
    assert.deepEqual(progress, ['new']);
    assert.ok(logs.some(message => /geometry cleanup/.test(message)));
    const delivered = [];
    for (const shard of first.shards) delivered.push(...JSON.parse(gunzipSync(
        await fs.readFile(path.join(f.assembly.artifactDirectory, shard.file))).toString()));
    await validateGlideShardPatches(delivered);
    const qualifications = new Set(originals.map(record => JSON.stringify(record[0])));
    assert.ok(delivered.every(record => qualifications.has(JSON.stringify(record[0]))));
    assert.ok(delivered.some(record => record[0][0] === -99596265), 'the previously invalid original retains its fit');
    assert.equal(await fs.readFile(f.spool.file, 'utf8'), text);
    assert.notEqual(await fs.readFile(f.mergedFile, 'utf8'), savedMerge);
    assert.notEqual(await fs.readFile(`${f.mergedFile}.build.json`, 'utf8'), savedReceipt);
    const resumed = await f.assembly.assemble(f.id, [{ ...f.spool, file: '/absent/spool' }]);
    assert.equal(resumed.reusedGroup, true);
    assert.deepEqual(resumed.shards, first.shards);
});

test('cleanup can checkpoint and resume an empty batch without republishing invalid geometry', async t => {
    const f = await fixture(t), bad = area(0);
    bad[1] = [[-98_000_000, 26_000_000, 100, 100, 0, -100, -100, 100]];
    const text = JSON.stringify(bad) + '\n';
    await fs.writeFile(f.spool.file, text);
    f.spool.sha256 = createHash('sha256').update(text).digest('hex');
    const logs: string[] = [];
    const first = await f.assembly.assemble(f.id, [f.spool], () => {}, message => logs.push(message));
    assert.equal(first.batches, 1);
    assert.deepEqual(first.shards, []);
    assert.match(logs[0], /geometry cleanup omitted invalid patch/);
    await fs.rm(path.join(f.cache, 'assembly', 'groups', `${f.id}.json`));
    const second = await f.assembly.assemble(f.id, [f.spool]);
    assert.equal(second.encodedCached, 1);
    assert.deepEqual(second.shards, []);
    await fs.rm(f.spool.file);
    assert.equal((await f.assembly.assemble(f.id, [f.spool])).reusedGroup, true);
});

test('old unvalidated delivery checkpoints are re-encoded from existing merges, without changing analysis', async t => {
    const f = await fixture(t);
    const first = await f.assembly.assemble(f.id, [f.spool]);
    const shared = { packaging: GLIDE_SHARD_POLICY, version: GLIDE_VERSION,
        implementation: inputs.implementation, rules: GLIDE_RULES, versions: inputs.versions };
    const oldGroup = buildFingerprint({ assembly: 1, id: f.id, inputs: buildFingerprint(shared), spools: [f.spool.sha256] });
    const merge = buildFingerprint({ ...shared, patches: buildFingerprint(f.records) });
    const oldBatch = buildFingerprint({ assembly: 1, id: `${f.id}-0`, merge });
    await writeCachedJson(path.join(f.cache, 'assembly', 'groups', `${f.id}.json`),
        path.join(f.cache, 'assembly', 'groups', `${f.id}.json.build.json`), oldGroup, { batches: 1, shards: first.shards });
    await writeCachedJson(path.join(f.cache, 'assembly', 'batches', `${f.id}-0.json`),
        path.join(f.cache, 'assembly', 'batches', `${f.id}-0.json.build.json`), oldBatch, { batches: 1, shards: first.shards });
    const progress: string[] = [];
    const validated = await f.assembly.assemble(f.id, [f.spool], batch => progress.push(batch.source));
    assert.deepEqual(progress, ['merged']);
    assert.equal(validated.reusedGroup, false);
    assert.deepEqual(validated.shards, first.shards, 'valid existing geometry produces identical artifact bytes');
});

test('version-2 gzip is adopted only after original-polygon validation, without recompression or merging', async t => {
    const f = await fixture(t), first = await f.assembly.assemble(f.id, [f.spool]);
    const shared = { packaging: GLIDE_SHARD_POLICY, version: GLIDE_VERSION,
        implementation: inputs.implementation, rules: GLIDE_RULES, versions: inputs.versions };
    const oldMerge = buildFingerprint({ ...shared, patches: buildFingerprint(f.records) });
    const groupFile = path.join(f.cache, 'assembly', 'groups', `${f.id}.json`);
    const batchFile = path.join(f.cache, 'assembly', 'batches', `${f.id}-0.json`);
    await writeCachedJson(groupFile, `${groupFile}.build.json`, buildFingerprint({ assembly: 2, id: f.id,
        inputs: buildFingerprint(shared), spools: [f.spool.sha256] }), { batches: 1, shards: first.shards });
    await writeCachedJson(batchFile, `${batchFile}.build.json`, buildFingerprint({ assembly: 2, id: `${f.id}-0`, merge: oldMerge }),
        { batches: 1, shards: first.shards });
    await fs.rm(path.dirname(f.mergedFile), { recursive: true });
    const sources: string[] = [], adopted = await f.assembly.assemble(f.id, [f.spool], batch => sources.push(batch.source));
    assert.deepEqual(sources, ['encoded']);
    assert.deepEqual(adopted.shards, first.shards);
    await assert.rejects(fs.stat(f.mergedFile), { code: 'ENOENT' });
    await fs.rm(f.spool.file);
    assert.equal((await f.assembly.assemble(f.id, [f.spool])).reusedGroup, true);
});

test('corrupt or missing gzip files and damaged receipts recover from saved merges', async t => {
    const f = await fixture(t);
    const first = await f.assembly.assemble(f.id, [f.spool]);
    const artifact = path.join(f.assembly.artifactDirectory, first.shards[0].file);
    const groupFile = path.join(f.cache, 'assembly', 'groups', `${f.id}.json`);
    const batchFile = path.join(f.cache, 'assembly', 'batches', `${f.id}-0.json`);
    for (const damage of [
        async () => {
            const bytes = await fs.readFile(artifact); bytes[bytes.length - 1] ^= 1;
            await fs.writeFile(artifact, bytes); // Same length, wrong checksum.
        },
        () => fs.rm(artifact),
        async () => {
            await fs.writeFile(`${groupFile}.build.json`, '{}');
            await fs.writeFile(batchFile, '{}');
        },
    ]) {
        await damage();
        const progress: string[] = [];
        const repaired = await f.assembly.assemble(f.id, [f.spool], batch => progress.push(batch.source));
        assert.deepEqual(progress, ['merged']);
        assert.deepEqual(repaired.shards, first.shards);
        assert.ok(await matchesArtifacts(f.assembly.artifactDirectory, repaired.shards));
    }
});

test('changed polygon bytes, tool or analysis identities, and rebuild cannot reuse stale assembly', async t => {
    const f = await fixture(t);
    await f.assembly.assemble(f.id, [f.spool]);
    const pool = await GdalPool.create(1, { library: null, version: 'test' });
    t.after(() => pool.close());
    const missed = new Error('new merge required');
    const command = t.mock.method(pool, 'command', async () => { throw missed; });
    for (const assembly of [
        new GlideAssembly(f.cache, f.work, { ...inputs, implementation: 'changed-screening' }),
        new GlideAssembly(f.cache, f.work, { ...inputs, versions: ['changed GDAL'] }),
        new GlideAssembly(f.cache, f.work, inputs, true),
    ]) await pool.run(() => assert.rejects(assembly.assemble(f.id, [f.spool]), error => error === missed));
    f.records[0][2] = 257;
    const text = f.records.map(record => JSON.stringify(record)).join('\n') + '\n';
    await fs.writeFile(f.spool.file, text);
    f.spool.sha256 = createHash('sha256').update(text).digest('hex');
    await pool.run(() => assert.rejects(f.assembly.assemble(f.id, [f.spool]), error => error === missed));
    assert.equal(command.mock.callCount(), 4);
});

test('publication reuses analysis, repairs delivery from saved gzip, and enforces budgets on resumed groups', async t => {
    const tools = ['gdalinfo', 'gdalwarp', 'gdal_translate', 'gdalbuildvrt', 'ogr2ogr', 'gdal_rasterize', 'gdal'];
    let versions: string[];
    try { versions = await Promise.all(tools.map(tool => gdalCli(tool, ['--version']).then(text => text.trim()))); }
    catch { t.skip('Requires GDAL'); return; }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-publication-resume-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const sourceFile = path.join(root, 'sources.json'), assetFile = path.join(root, 'source.fixture');
    await fs.writeFile(assetFile, 'unchanged sources for verified analysis checkpoints');
    const asset = { name: 'fixture', date: '2026-01-01', attribution: 'test', file: assetFile };
    const inventory = validateGlideInventory({ schemaVersion: 1, regions: [{ id: 'fixture',
        bounds: [-98, 26, -97.99, 26.01], coverageBounds: [-99, 25, -97, 27],
        sources: Object.fromEntries([...RASTER_ROLES, ...VECTOR_ROLES].map(role => [role, [asset]])) }] });
    await fs.writeFile(sourceFile, JSON.stringify(inventory));
    const cache = path.join(root, 'glide-cache');
    const [region] = await resolveGlideSources(inventory, sourceFile, cache);
    // Seed the actual pre-optimization receipt format, including its old code
    // hash and all-dates identity. The builder must adopt it without analysis.
    const implementation = 'cd4afcbc8f991234b98e8a43cb16343d21963f53818cfe9a6bb5e9f236c051e9';
    const { areaSimplificationM: _, ...rules } = GLIDE_RULES;
    const regionFingerprint = buildFingerprint({ version: GLIDE_VERSION, implementation, rules, versions,
        bounds: region.bounds, coverageBounds: region.coverageBounds,
        sources: Object.fromEntries([...ALL_RASTER_ROLES, ...OPTIONAL_VECTOR_ROLES, ...VECTOR_ROLES].map(role =>
            [role, (region.sources[role] ?? []).map(({ sha256, bytes, date }) => ({ sha256, bytes, date }))])) });
    const checkpointTimes = new Map<string, number>();
    for (const chunk of glideChunks(region)) {
        const file = path.join(cache, `analysis-v${GLIDE_VERSION}`, 'area-chunks', `${chunk.id}.json`);
        await writeCachedJson(file, `${file}.build.json`, buildFingerprint({ regionFingerprint, chunk }),
            { areas: [area(0), area(1)], screening: null });
        checkpointTimes.set(file, (await fs.stat(file)).mtimeMs);
    }
    t.mock.method(GlideChunkWorkers.prototype, 'run', () => { throw new Error('Completed analysis must not rerun'); });
    const pools: number[] = [], createPool = GdalPool.create.bind(GdalPool);
    t.mock.method(GdalPool, 'create', (concurrency: number, settings) => {
        pools.push(concurrency);
        return createPool(concurrency, settings);
    });
    const logs: string[] = [], options = { concurrency: 1, regionConcurrency: 1, assemblyConcurrency: 8,
        log: (message: string) => logs.push(message) };
    const first = await buildGlide(root, sourceFile, options);
    assert.deepEqual(pools, [1, 8], 'assembly GDAL capacity is independent of preparation capacity');
    assert.equal(first.schemaVersion, 9);
    assert.equal(first.qualificationTuple.length, 10);
    assert.equal(first.coverage[0].shrubEvidenceMissing, true);
    assert.ok(first.shards.length);
    for (const chunk of glideChunks(region)) {
        const file = path.join(cache, `analysis-v${GLIDE_VERSION}`, 'area-chunks', `${chunk.id}.json`);
        assert.equal((await fs.stat(file)).mtimeMs, checkpointTimes.get(file));
        assert.equal(JSON.parse(await fs.readFile(`${file}.build.json`, 'utf8')).inputSha256,
            buildFingerprint({ regionFingerprint: glideAnalysisFingerprints(region, versions)[0], chunk }));
    }
    assert.ok(logs.some(message => message.includes('gzip checkpoint saved')));
    const publication = path.join(root, 'charts', 'glide'), manifestFile = path.join(publication, 'manifest.json');
    assert.ok(await matchesArtifacts(publication, [first.provenance, ...first.shards]));
    // The first run adopted exact legacy keys. Later irrelevant metadata changes
    // must reuse that analysis under the new keys, even though provenance changes.
    const refreshedInventory = JSON.parse(await fs.readFile(sourceFile, 'utf8'));
    refreshedInventory.regions[0].sources.obstacles[0].date = '2026-02-01';
    await fs.writeFile(sourceFile, JSON.stringify(refreshedInventory));
    const refreshed = await buildGlide(root, sourceFile, options);
    assert.deepEqual(refreshed.shards, first.shards);
    assert.notEqual(refreshed.provenance.sha256, first.provenance.sha256);
    // A corrupted delivered file forces assembly, which can reuse persistent gzip.
    await fs.writeFile(path.join(publication, first.shards[0].file), 'corrupt');
    logs.length = 0;
    const repaired = await buildGlide(root, sourceFile, options);
    assert.deepEqual(repaired.shards, first.shards);
    assert.ok(logs.some(message => message.includes('reused completed group')));
    assert.ok(await matchesArtifacts(publication, [repaired.provenance, ...repaired.shards]));
    // Force assembly after an interrupted manifest receipt write, then hit the
    // aggregate budget. Cached groups must obey it and leave publication intact.
    const before = await fs.readFile(manifestFile, 'utf8');
    await fs.rm(path.join(cache, 'manifest.build.json'));
    await assert.rejects(buildGlide(root, sourceFile, { ...options, maxBytes: 1 }), /exceeds --max-bytes/);
    assert.equal(await fs.readFile(manifestFile, 'utf8'), before);
    assert.ok(await matchesArtifacts(publication, [repaired.provenance, ...repaired.shards]));
    logs.length = 0;
    // Resume after assembly failed, with the original source no longer available.
    // The complete input inventory must already have been committed, and the
    // assembly-only entry point must never rediscover or check source files.
    await fs.rm(assetFile);
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('Assembly-only must not use the network'); });
    const resumed = await resumeGlideAssembly(root, options);
    assert.deepEqual(resumed.shards, first.shards);
    assert.ok(logs.some(message => message.includes('reused completed group')));
    assert.ok(!(await fs.readdir(cache)).some(name => name.startsWith('.work-')));
});
