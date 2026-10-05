import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import test, { type TestContext } from 'node:test';
import { main } from '../build-glide.ts';
import { auditGlideAssembly, resumeGlideAssembly } from '../lib/glide-assembly-resume.ts';
import { GlideAssembly } from '../lib/glide-assembly.ts';
import { glideAnalysisIdentity } from '../lib/glide-identity.ts';
import { GdalPool, gdalCli } from '../lib/gdal.ts';
import { buildFingerprint, matchesArtifacts, writeCachedJson } from '../lib/build-cache.ts';
import { glideChunks, RASTER_ROLES, VECTOR_ROLES, type GlideLandingArea, type GlideRegion } from '../lib/glide-model.ts';
import { GlideChunkWorkers } from '../lib/glide-worker.ts';

const area: GlideLandingArea = [[-97997000, 26010000, -97995000, 26010000, 60, 600, 123, 1, 0, 0],
    [[-97997100, 26009900, 2200, 0, 0, 200, -2200, 0]], 256];
const tools = ['gdalinfo', 'gdalwarp', 'gdal_translate', 'gdalbuildvrt', 'ogr2ogr', 'gdal_rasterize', 'gdal'];

async function fixture(t: TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-resume-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const cache = path.join(root, 'glide-cache'), analysis = path.join(cache, 'analysis-v1');
    const asset = { name: 'unavailable source', date: '2026-01-01', attribution: 'test', file: '/absent/source.tif' };
    const region: GlideRegion = { id: 'fixture', bounds: [-98, 26, -97.75, 26.125], coverageBounds: [-99, 25, -97, 27],
        sources: Object.fromEntries([...RASTER_ROLES, ...VECTOR_ROLES].map(role => [role, [asset]])) as GlideRegion['sources'] };
    const sources = path.join(root, 'sources.json');
    await fs.writeFile(sources, JSON.stringify({ schemaVersion: 1, regions: [region] }));
    const chunks = [...glideChunks(region)];
    const files = chunks.map((chunk, i) => path.join(analysis, i ? 'ground-rejections' : 'area-chunks', `${chunk.id}.json`));
    for (const [i, file] of files.entries()) await writeCachedJson(file, `${file}.build.json`, buildFingerprint({ chunk: chunks[i] }),
        { areas: i ? [] : [area], screening: null });
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network must not be used during assembly-only'); });
    t.mock.method(GlideChunkWorkers.prototype, 'run', () => { throw new Error('Analysis must not run during assembly-only'); });
    return { root, cache, analysis, sources, chunks, files };
}

test('older completed checkpoints resume existing gzip groups without source reads, and remain pinned on restart', async t => {
    const f = await fixture(t), versions = await Promise.all(tools.map(tool => gdalCli(tool, ['--version']).then(v => v.trim())));
    const spoolFile = path.join(f.root, 'original.jsonl'), text = JSON.stringify(area) + '\n';
    await fs.writeFile(spoolFile, text);
    const assembly = new GlideAssembly(f.analysis, f.root, { implementation: glideAnalysisIdentity(), versions });
    const previous = await assembly.assemble(f.chunks[0].shard,
        [{ file: spoolFile, sha256: createHash('sha256').update(text).digest('hex') }]);
    const before = await Promise.all(f.files.map(file => fs.readFile(file, 'utf8')));
    t.mock.method(GdalPool.prototype, 'command', async () => { throw new Error('A completed group must not be re-merged or revalidated'); });
    const logs: string[] = [];
    const result = await resumeGlideAssembly(f.root, { sources: f.sources, log: message => logs.push(message) });
    assert.deepEqual(result.shards, previous.shards);
    assert.ok(logs.some(message => message.includes('reused completed group')));
    assert.deepEqual(await Promise.all(f.files.map(file => fs.readFile(file, 'utf8'))), before);
    const publication = path.join(f.root, 'charts/glide');
    assert.ok(await matchesArtifacts(publication, [result.provenance, ...result.shards]));
    assert.equal(JSON.parse(await fs.readFile(path.join(publication, result.provenance.file), 'utf8')).recovery.sourceInventoryAvailable, false);
    // With known spool hashes, saved groups need no original polygons at all.
    await Promise.all(f.files.map(file => fs.rm(file)));
    await fs.rm(f.sources);
    await fs.rm(path.join(f.cache, 'manifest.build.json'));
    const resumed = await resumeGlideAssembly(f.root, { log: () => {} });
    assert.deepEqual(resumed.shards, previous.shards);
    await assert.rejects(resumeGlideAssembly(f.root, { bounds: [-98, 26, -97.875, 26.125], log: () => {} }), /different --sources\/--bbox/);
    await assert.rejects(resumeGlideAssembly(f.root, { maxBytes: 1, log: () => {} }), /exceeds --max-bytes/);
    assert.ok(await matchesArtifacts(publication, [resumed.provenance, ...resumed.shards]));
});

test('assembly-only builds missing shards from verified analysis without acquiring sources', async t => {
    const f = await fixture(t);
    const result = await resumeGlideAssembly(f.root, { sources: f.sources, assemblyConcurrency: 2, log: () => {} });
    assert.equal(result.shards.length, 1);
    assert.deepEqual(JSON.parse(gunzipSync(await fs.readFile(path.join(f.root, 'charts/glide', result.shards[0].file))).toString()), [area]);
    assert.equal((await fs.readdir(f.cache)).some(name => name.startsWith('.assembly-')), false);
});

test('missing or ambiguous chunks cannot turn an incomplete region into a complete assembly', async t => {
    const f = await fixture(t), missing = await fs.readFile(f.files[1]);
    await fs.rm(f.files[1]);
    await assert.rejects(resumeGlideAssembly(f.root, { sources: f.sources, log: () => {} }), /checkpoint is missing/);
    await fs.writeFile(f.files[1], missing);
    const duplicate = path.join(f.analysis, 'area-chunks', `${f.chunks[1].id}.json`);
    await fs.writeFile(duplicate, missing);
    await assert.rejects(resumeGlideAssembly(f.root, { sources: f.sources, log: () => {} }), /both candidate and rejection/);
    await assert.rejects(fs.stat(path.join(f.cache, 'assembly-input.json')), { code: 'ENOENT' });
});

test('corrupt analysis or input inventory fails without rebuilding or replacing the previous publication', async t => {
    const f = await fixture(t);
    const publication = path.join(f.root, 'charts/glide'); await fs.mkdir(publication, { recursive: true });
    const manifest = path.join(publication, 'manifest.json'); await fs.writeFile(manifest, 'previous publication');
    await fs.appendFile(f.files[0], ' ');
    await assert.rejects(resumeGlideAssembly(f.root, { sources: f.sources, log: () => {} }), /checkpoint changed or corrupt/);
    assert.equal(await fs.readFile(manifest, 'utf8'), 'previous publication');
    const audit = await auditGlideAssembly(f.root, { log: () => {} });
    assert.equal(audit.failedBatches, 1);
    assert.match(audit.groups[0].failures[0].error, /checkpoint changed or corrupt/);
    assert.equal(await fs.readFile(manifest, 'utf8'), 'previous publication');
    const saved = JSON.parse(await fs.readFile(path.join(f.cache, 'assembly-audit.json'), 'utf8'));
    assert.deepEqual(saved, audit);
    await fs.writeFile(path.join(f.cache, 'assembly-input.json'), '{broken json');
    await assert.rejects(resumeGlideAssembly(f.root, { sources: f.sources, log: () => {} }), /input inventory is corrupt/);
    await assert.rejects(auditGlideAssembly(f.root, { log: () => {} }), /intact assembly-input/);
    assert.equal(await fs.readFile(manifest, 'utf8'), 'previous publication');
});

test('assembly-only CLI rejects analysis options before doing any work', async () => {
    for (const flag of ['--rebuild', '--refresh-sources', '--estimate', '--concurrency=2', '--region-concurrency=2']) {
        await assert.rejects(main(['--assembly-only', '--skip-packaging', flag]), /--assembly-only cannot be combined/);
    }
});
