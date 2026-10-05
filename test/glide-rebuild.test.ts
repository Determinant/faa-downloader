import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildFingerprint, writeCachedJson } from '../lib/build-cache.ts';
import { sha256File } from '../lib/fs-utils.ts';
import { GdalPool } from '../lib/gdal.ts';
import { createGlideManifest, readGlideAssemblyInput, writeGlideAssemblyInput } from '../lib/glide-assembly-resume.ts';
import { glideAnalysisFingerprints, glideAnalysisIdentity } from '../lib/glide-identity.ts';
import { glideChunks, type GlideLandingArea, type ResolvedRegion } from '../lib/glide-model.ts';
import { rebuildGlideChunks, type GlideRebuildPlan } from '../lib/glide-rebuild.ts';
import { GlideChunkWorkers } from '../lib/glide-worker.ts';

test('targeted replacement rejects changed sources and resumes an interrupted commit without touching publication', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-rebuild-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const cache = path.join(root, 'glide-cache'); await fs.mkdir(cache);
    const source = path.join(root, 'source.tif'); await fs.writeFile(source, 'cached source');
    const asset = { file: source, name: 'fixture', date: '2026-01-01', attribution: 'fixture',
        sha256: await sha256File(source), bytes: (await fs.stat(source)).size };
    const region: ResolvedRegion = { id: 'fixture', bounds: [-98, 26, -97.875, 26.125], coverageBounds: [-99, 25, -97, 27],
        sources: { elevation: [asset], landcover: [asset], canopy: [asset], impervious: [asset],
            buildings: [asset], powerlines: [asset], obstacles: [asset], water: [asset], roads: [asset] } };
    const [chunk] = [...glideChunks(region)];
    const area: GlideLandingArea = [[-97998000, 26010000, -97995000, 26010000, 60, 900, 123, 1, 0, 0],
        [[-97999000, 26009000, 6000, 0, 0, 2000, -6000, 0]], 256];
    const old = { areas: [area], screening: null }, fixed = structuredClone(old);
    fixed.areas[0][1][0][2] -= 1; fixed.areas[0][1][0][6] += 1;
    const file = path.join(cache, 'analysis-v1', 'area-chunks', `${chunk.id}.json`);
    const regionFingerprint = glideAnalysisFingerprints(region, [])[0];
    const analysisKey = buildFingerprint({ regionFingerprint, chunk });
    await writeCachedJson(file, `${file}.build.json`, analysisKey, old);
    const provenance = path.join(cache, 'assembly-inputs', 'source.json'); await fs.mkdir(path.dirname(provenance));
    await fs.writeFile(provenance, '{}\n');
    const manifest = createGlideManifest('old-publication', { file: 'source.json', sha256: await sha256File(provenance), bytes: 3 },
        [{ id: region.id, bounds: region.bounds }]);
    await writeGlideAssemblyInput(cache, { schemaVersion: 1, deliveryVersion: 3, selection: {}, implementation: glideAnalysisIdentity(),
        versions: [], manifest, recovered: true,
        chunks: [{ ...chunk, group: chunk.shard, file: path.relative(cache, file), kind: 'analysis',
            sha256: await sha256File(file), bytes: (await fs.stat(file)).size, inputSha256: analysisKey }],
        groups: [{ id: chunk.shard, spools: [{ chunks: [0], sha256: 'old-spool' }] }] });
    const publication = path.join(root, 'charts', 'glide', 'manifest.json'); await fs.mkdir(path.dirname(publication), { recursive: true });
    await fs.writeFile(publication, 'previous publication');
    const plan: GlideRebuildPlan = { schemaVersion: 1, inputSha256: manifest.inputSha256, chunks: [chunk.id], regions: [region] };
    const producer = buildFingerprint(await Promise.all(['glide-areas', 'glide-display'].map(name =>
        fs.readFile(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8'))));
    const key = buildFingerprint({ plan, producer }), staging = path.join(cache, 'targeted-rebuild', key);
    const resultFile = path.join(staging, 'chunks', `${chunk.id}.json`);
    await writeCachedJson(resultFile, `${resultFile}.build.json`, buildFingerprint({ key, chunk }), fixed);
    t.mock.method(GdalPool, 'create', async () => ({ versions: [], run: task => task(), close: async () => {} }));
    t.mock.method(GlideChunkWorkers.prototype, 'run', () => { throw new Error('Completed chunk must be reused'); });
    t.mock.method(globalThis, 'fetch', () => { throw new Error('Targeted rebuild must stay offline'); });
    await fs.writeFile(source, 'corrupt');
    await assert.rejects(rebuildGlideChunks(root, plan, { log: () => {} }), /Cached source changed/);
    assert.equal((await readGlideAssemblyInput(cache))!.manifest.inputSha256, manifest.inputSha256);
    await fs.writeFile(source, 'cached source');
    // Simulate stopping after the inventory swap, before ordinary cache refresh.
    const rename = fs.rename; let fail = true;
    t.mock.method(fs, 'rename', async (from, to) => {
        if (to === file && fail) { fail = false; throw new Error('simulated interruption'); }
        return rename(from, to);
    });
    await assert.rejects(rebuildGlideChunks(root, plan, { log: () => {} }), /simulated interruption/);
    const replaced = (await readGlideAssemblyInput(cache))!;
    assert.notEqual(replaced.manifest.inputSha256, manifest.inputSha256);
    assert.equal(replaced.groups[0].spools[0].sha256, undefined);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(cache, replaced.chunks[0].file), 'utf8')), fixed);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), old);
    // A stop between the inventory JSON and receipt replacements is also
    // repairable, but only because its bytes match the saved commit intent.
    await fs.rm(path.join(cache, 'assembly-input.json.build.json'));
    assert.equal(await readGlideAssemblyInput(cache), undefined);
    await rebuildGlideChunks(root, plan, { log: () => {} });
    assert.equal((await readGlideAssemblyInput(cache))!.manifest.inputSha256, replaced.manifest.inputSha256);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), fixed);
    const before = JSON.parse(await fs.readFile(path.join(staging, 'before-input.json'), 'utf8'));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(cache, before.chunks[0].file), 'utf8')), old);
    assert.equal(await fs.readFile(publication, 'utf8'), 'previous publication');
});
