import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DELIVERY_LIMITS as L, hash, inspectArea, jsonBytes, unionBounds, type Area, type SourceManifest, type Artifact } from '../lib/glide-delivery.ts';
import { decodeDetail, encodeArchive, readArchiveDirectory, inflateBlock } from '../lib/glide-package-archive.ts';
import { packageDetailShard } from '../lib/glide-package-detail.ts';
import { addChildDensity, densityFractions, encodeDensity, rasterizeAreas } from '../lib/glide-package-overview.ts';
import { packageGlide, cleanGlidePackages, glideRegionCoverage } from '../lib/glide-packager.ts';
import { main } from '../build-glide-packages.ts';
import { freezeGlideAnalysis, freezeGlideChunk, validateFrozenAnalysis } from '../lib/glide-frozen-analysis.ts';
import { exportGlidePackages, verifyGlidePackages } from '../lib/glide-package-verify.ts';
import { validateDeliveryManifest, validateDependencyPage, validateIndex, validateRegionInventory } from '../lib/glide-package-validation.ts';
import { GlideChunkWorkers } from '../lib/glide-worker.ts';

const area = (x = -120_010_000, y = 35_000_000, tier = 1, schema = 8): Area => {
    const q = [x, y, x + 1000, y, 60, 600, 123, tier]; if (schema === 9) q.push(12, 4);
    return [q, [[x - 2000, y - 2000, 8000, 0, 0, 6000, -8000, 0]], 256];
};
async function fixture(t: TestContext, records = [area(), area(-120_004_000, 35_000_000, 2)]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-packages-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
    const input = path.join(root, 'source'), output = path.join(root, 'output'); await fs.mkdir(input);
    const raw = jsonBytes(records), data = gzipSync(raw), sha256 = hash(data), file = `${sha256}.glide.gz`;
    await fs.writeFile(path.join(input, file), data);
    const provenance = jsonBytes({ engine: 'historical', inputs: [] }), provenanceHash = hash(provenance);
    const provenanceEntry = { file: `${provenanceHash}.glide-sources.json`, bytes: provenance.length, sha256: provenanceHash };
    await fs.writeFile(path.join(input, provenanceEntry.file), provenance);
    const bounds = unionBounds(records.map(a => inspectArea(a, a[0].length === 10 ? 9 : 8).bounds)), tiers: [number, number] = [0, 0];
    records.forEach(a => tiers[a[0][7] - 1]++);
    const manifest: SourceManifest = { schemaVersion: records[0][0].length === 10 ? 9 : 8, builderVersion: 20,
        generatedAt: '2025-01-01T00:00:00.000Z', inputSha256: '1'.repeat(64), status: 'experimental-candidates',
        geometryMeaning: 'generalized-candidate-area', rules: { historicalRule: 42 },
        coverage: [{ id: 'historical-region', bounds, shrubEvidenceMissing: true }], provenance: provenanceEntry,
        shards: [{ id: 'source', file, bytes: data.length, sha256, bounds, count: records.length, rawBytes: raw.length, tiers }] };
    const manifestFile = path.join(input, 'manifest.json'); await fs.writeFile(manifestFile, jsonBytes(manifest));
    const regions = [{ id: 'us-test-a', title: 'West', bounds: [[-120.1, 34.9, -120.003, 35.1] as [number, number, number, number]] },
        { id: 'us-test-b', title: 'East', bounds: [[-120.003, 34.9, -119.9, 35.1] as [number, number, number, number]] }];
    const options = { input: manifestFile, output, regions, log: () => {} };
    return { root, input, output, records, manifest, manifestFile, options };
}

test('historical publication repacks exactly, shares regional files and reuses deterministic outputs without sources', async t => {
    const f = await fixture(t), original = await fs.readFile(f.manifestFile), result = await packageGlide(f.options);
    assert.equal(result.source.builderVersion, 20); assert.deepEqual(result.source.rules, { historicalRule: 42 });
    assert.equal(result.records, f.records.length);
    const directory = path.join(f.output, 'charts/glide'), decoded = new Map<string, Area>(), files = new Map<string, Artifact>();
    for (const index of result.indexes) {
        files.set(index.file, index);
        const page = JSON.parse(await fs.readFile(path.join(directory, index.file), 'utf8'));
        for (const archive of page.archives) {
            files.set(archive.file, archive);
            const bytes = await fs.readFile(path.join(directory, archive.file)), entries = readArchiveDirectory(bytes);
            assert.deepEqual(entries, archive.blocks);
            for (const block of entries) {
                const compressed = bytes.subarray(block.offset, block.offset + block.bytes);
                if (block.kind === 'detail') {
                    const detail = decodeDetail(compressed, block);
                    detail.indices.forEach((index, i) => {
                        const id = `${detail.source}:${index}`; assert.equal(decoded.has(id), false); decoded.set(id, detail.areas[i]);
                    });
                } else assert.equal(inflateBlock(compressed, block).length, 256 * 256 * 3);
            }
        }
    }
    f.records.forEach((a, i) => assert.deepEqual(decoded.get(`${f.manifest.shards[0].sha256}:${i}`), a));
    assert.equal(decoded.size, f.records.length);
    const inventories = await Promise.all(result.regions.map(r => fs.readFile(path.join(directory, r.file), 'utf8').then(JSON.parse)));
    const shared = inventories[0].files.filter(a => a.file.startsWith('detail/') && inventories[1].files.some(b => b.file === a.file));
    assert.ok(shared.length, 'border polygons use shared archives');
    for (const inventory of inventories) for (const entry of inventory.files) assert.equal(hash(await fs.readFile(path.join(directory, entry.file))), entry.sha256);
    assert.deepEqual(await fs.readFile(f.manifestFile), original);
    assert.deepEqual(await packageGlide(f.options), result);
    assert.deepEqual(await packageGlide({ ...f.options, forcePackaging: true }), result);
    const report = JSON.parse(await fs.readFile(path.join(f.output, 'glide-package-cache/report.json'), 'utf8'));
    assert.equal(report.downloads, 0); assert.equal(report.analyzedChunks, 0); assert.equal(report.detailPreserved, true);
    let physical = 0;
    for (const folder of await fs.readdir(directory, { withFileTypes: true })) {
        if (folder.isFile()) physical += (await fs.stat(path.join(directory, folder.name))).size;
        else for (const file of await fs.readdir(path.join(directory, folder.name))) physical += (await fs.stat(path.join(directory, folder.name, file))).size;
    }
    assert.equal(result.totalBytes, physical);
    const verified = await verifyGlidePackages(f.output, () => {});
    assert.equal(verified.bytes, physical); assert.equal(verified.records, f.records.length);
});

test('corrupt inputs fail without replacing a prior release; delivery byte limits apply to reuse', async t => {
    const f = await fixture(t), result = await packageGlide(f.options), destination = path.join(f.output, 'charts/glide/manifest.json');
    const before = await fs.readFile(destination);
    await assert.rejects(packageGlide({ ...f.options, maxBytes: result.totalBytes - 1 }), /byte budget/);
    assert.deepEqual(await fs.readFile(destination), before);
    await fs.rm(path.join(f.output, 'glide-package-cache/inputs'), { recursive: true });
    await fs.writeFile(path.join(f.input, f.manifest.shards[0].file), 'damaged');
    await assert.rejects(packageGlide(f.options), /Invalid\/missing pinned/);
    assert.deepEqual(await fs.readFile(destination), before);
});

test('schema-9 fields survive, source mutations cannot affect pinned input, cleanup keeps committed snapshots', async t => {
    const f = await fixture(t, [area(-120_010_000, 35_000_000, 1, 9)]);
    const first = await packageGlide(f.options);
    const directory = path.join(f.output, 'charts/glide');
    const orphan = path.join(directory, 'detail', `${'a'.repeat(64)}.gld`); await fs.writeFile(orphan, 'unreferenced');
    await cleanGlidePackages(f.output); await assert.rejects(fs.stat(orphan), { code: 'ENOENT' });
    await fs.writeFile(path.join(f.input, f.manifest.shards[0].file), 'source edited in place');
    assert.deepEqual(await packageGlide(f.options), first, 'verified isolated input snapshot survives later source edits');
});

test('archive parser rejects corrupt offsets and can read one block without decoding its neighbor', async t => {
    const f = await fixture(t), blocks = await packageDetailShard(f.records, f.manifest.shards[0], 8, f.output, 'test');
    const block = blocks[0], { file: _, ...descriptor } = block, data = await fs.readFile(path.join(f.output, block.file));
    const encoded = encodeArchive([{ block: descriptor, data }, { block: { ...descriptor, key: 'second' }, data }]);
    const entries = readArchiveDirectory(encoded.data), copy = Buffer.from(encoded.data);
    copy[entries[1].offset] ^= 255;
    assert.doesNotThrow(() => decodeDetail(copy.subarray(entries[0].offset, entries[0].offset + entries[0].bytes), entries[0]));
    assert.throws(() => decodeDetail(copy.subarray(entries[1].offset, entries[1].offset + entries[1].bytes), entries[1]), /identity/);
    const damaged = Buffer.from(encoded.data); damaged.writeUInt32LE(0xffffffff, 8);
    assert.throws(() => readArchiveDirectory(damaged), /directory length/);
    assert.throws(() => readArchiveDirectory(encoded.data.subarray(0, encoded.data.length - 1)), /outside file|missing/);
});

test('overview resolves overlaps and holes before density aggregation and keeps preparation independent', () => {
    const outer = area(), preferred = structuredClone(outer); preferred[0][7] = 2;
    preferred[1].push([-120_010_500, 34_999_500, 1000, 0, 0, 1000, -1000, 0]);
    const once = rasterizeAreas([preferred], 10), twice = rasterizeAreas([preferred, preferred], 10);
    assert.deepEqual(twice, once, 'overlapping duplicate patches do not double density');
    const overlap = rasterizeAreas([outer, preferred], 10);
    let preferredSamples = 0, purpleSamples = 0, preparedEmpty = 0;
    for (const [key, mask] of overlap) {
        const values = densityFractions(key.split('/').map(Number) as [number, number, number], mask,
            [{ id: 'prepared', bounds: [-120.05, 34.95, -119.95, 35.05] }]);
        const encoded = encodeDensity(values);
        for (let i = 0; i < encoded.length; i += 3) {
            preferredSamples += encoded[i]; purpleSamples += encoded[i + 1];
            preparedEmpty += Number(encoded[i] === 0 && encoded[i + 1] === 0 && encoded[i + 2] > 0);
            assert.ok(encoded[i] + encoded[i + 1] <= encoded[i + 2]);
        }
    }
    assert.ok(preferredSamples > 0 && purpleSamples > 0 && preparedEmpty > 0);
    const parent = new Float64Array(256 * 256 * 3), child = new Float64Array(parent.length);
    for (let i = 0; i < child.length; i += 3) { child[i] = .25; child[i + 1] = .5; child[i + 2] = 1; }
    for (const x of [0, 1]) for (const y of [0, 1]) addChildDensity(parent, child, [1, x, y]);
    for (let i = 0; i < parent.length; i += 3) {
        assert.ok(Math.abs(parent[i] - .25) < 1e-12); assert.ok(Math.abs(parent[i + 1] - .5) < 1e-12); assert.ok(Math.abs(parent[i + 2] - 1) < 1e-12);
    }
});

test('CLI requires isolated input/output and rejects analysis rebuild options', async t => {
    const f = await fixture(t);
    await assert.rejects(main(['--input=' + f.manifestFile]), /explicit separate/);
    await assert.rejects(main(['--rebuild']), /Unknown packaging option/);
    await assert.rejects(packageGlide({ ...f.options, output: f.input }), /does not overlap/);
    await assert.rejects(packageGlide({ ...f.options, maxBytes: 5_000_000_000 }), /below/);
});

test('explicit frozen reassembly uses historical results, records empty chunks, and never invokes acquisition or analysis', async t => {
    const f = await fixture(t), cache = path.join(f.root, 'historical-cache');
    t.mock.method(GlideChunkWorkers.prototype, 'run', () => { throw new Error('Analysis must never run'); });
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('Acquisition must never run'); });
    const chunks = [await freezeGlideChunk(cache, { id: 'old-positive', shard: '-121-35', bounds: f.manifest.coverage[0].bounds }, f.records),
        await freezeGlideChunk(cache, { id: 'old-empty', shard: '-121-35', bounds: f.manifest.coverage[0].bounds }, [])];
    const snapshot = await freezeGlideAnalysis(cache, f.manifest, chunks,
        await fs.readFile(path.join(f.input, f.manifest.provenance.file)), '2'.repeat(64), f.input);
    const frozen = JSON.parse(await fs.readFile(snapshot, 'utf8')); validateFrozenAnalysis(frozen);
    assert.equal(frozen.expectedChunks, 2); assert.equal(frozen.chunks[1].count, 0);
    await assert.rejects(packageGlide({ ...f.options, input: snapshot }), /schema-8\/9/);
    const result = await packageGlide({ ...f.options, input: snapshot, reassemble: true });
    assert.equal(result.source.builderVersion, 20); assert.deepEqual(result.source.rules, { historicalRule: 42 });
    assert.equal((result.source.reassembly as any).originalAnalysisImplementation, '2'.repeat(64));
    assert.equal((result.source.reassembly as any).inputRecords, 2);
    const comparison = (result.source.reassembly as any).comparison;
    assert.equal(comparison.baseline.counts.records, 2);
    assert.equal(comparison.assembled.counts.records, result.records);
    assert.equal(typeof comparison.equal.holes, 'boolean');
    assert.deepEqual(await packageGlide({ ...f.options, input: snapshot, reassemble: true }), result);
    await fs.rm(path.join(f.output, 'glide-package-cache/analysis-inputs'), { recursive: true });
    await fs.rm(path.join(path.dirname(snapshot), frozen.chunks[1].file));
    await assert.rejects(packageGlide({ ...f.options, input: snapshot, reassemble: true }), /ENOENT/);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.output, 'charts/glide/manifest.json'), 'utf8')).inputSha256, result.inputSha256);
});

test('bounded large-record blocks preserve indivisible geometry and expose the exception to readers', async t => {
    const value = area(), ring: number[] = [], vertices = 70_000;
    let previousX = 0, previousY = 0;
    for (let i = 0; i < vertices; i++) {
        const a = i / vertices * Math.PI * 2, x = Math.round(-120e6 + Math.cos(a) * 500_000), y = Math.round(35e6 + Math.sin(a) * 500_000);
        ring.push(x - previousX, y - previousY); previousX = x; previousY = y;
    }
    value[1] = [ring];
    const f = await fixture(t, [value]);
    const blocks = await packageDetailShard(f.records, f.manifest.shards[0], 8, f.output, 'large-fixture');
    assert.equal(blocks.length, 1); assert.equal(blocks[0].oversized, true); assert.equal(blocks[0].vertices, vertices);
    const decoded = decodeDetail(await fs.readFile(path.join(f.output, blocks[0].file)), blocks[0]);
    assert.deepEqual(decoded.areas, f.records);
    const limited = { ...blocks[0], oversized: undefined };
    assert.throws(() => decodeDetail(gzipSync(jsonBytes(decoded)), limited), /Invalid glide archive block/);
});

test('a singleton exceeding only the compressed limit uses the lossless large-record exception', async t => {
    const value = area(), ring: number[] = [];
    let seed = 12345, x = 0, y = 0;
    for (let i = 0; i < 60_000; i++) {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        const radius = 100_000 + (seed >>> 0) / 4294967296 * 100_000, theta = i * 2 * Math.PI / 60_000;
        const nx = -120_010_000 + Math.round(Math.cos(theta) * radius), ny = 35_000_000 + Math.round(Math.sin(theta) * radius);
        ring.push(nx - x, ny - y); x = nx; y = ny;
    }
    value[1] = [ring];
    const f = await fixture(t, [value]);
    const blocks = await packageDetailShard(f.records, f.manifest.shards[0], 8, f.output, 'compressed-singleton');
    assert.equal(blocks.length, 1);
    const [block] = blocks;
    assert.ok(block.rawBytes <= L.blockRawBytes && block.vertices <= L.vertices && block.rings <= L.rings);
    assert.ok(block.bytes > L.blockBytes && block.bytes <= L.oversizedBlockBytes);
    assert.equal(block.oversized, true);
    assert.deepEqual(decodeDetail(await fs.readFile(path.join(f.output, block.file)), block).areas, f.records);
    assert.deepEqual(await packageDetailShard(f.records, f.manifest.shards[0], 8, f.output, 'compressed-singleton'), blocks);
});

test('tile-grid changes invalidate payload checkpoints and cached output matches a clean repack', async t => {
    const f = await fixture(t);
    const implementation = path.join(f.root, 'implementation');
    await fs.cp(new URL('../lib/', import.meta.url), path.join(implementation, 'lib'), { recursive: true });
    await fs.writeFile(path.join(implementation, 'package.json'), '{"type":"module"}\n');
    const runner = path.join(implementation, 'run.mjs');
    await fs.writeFile(runner, `import { packageGlide } from './lib/glide-packager.ts';\n` +
        `await packageGlide({ input: ${JSON.stringify(f.manifestFile)}, output: process.argv[2], regions: [], concurrency: 1, log: () => {} });\n`);
    const run = (output: string) => promisify(execFile)(process.execPath, [runner, output]);
    await run(f.output);
    const grid = path.join(implementation, 'lib/chart-package-grid.ts');
    const original = await fs.readFile(grid, 'utf8');
    const changed = original.replace('latitude(y)];', 'latitude(y)].map(v => Number(v.toFixed(8))) as Bounds;');
    assert.notEqual(changed, original, 'fixture changes the shared tile bounds implementation');
    await fs.writeFile(grid, changed);
    await run(f.output);
    const fresh = path.join(f.root, 'fresh'); await run(fresh);
    assert.deepEqual(await fs.readFile(path.join(f.output, 'charts/glide/manifest.json')),
        await fs.readFile(path.join(fresh, 'charts/glide/manifest.json')));
    const receipts = await fs.readdir(path.join(f.output, 'glide-package-cache/detail'));
    assert.equal(receipts.filter(file => !file.endsWith('.build.json')).length, 2, 'detail also receives the new grid identity');
});

test('independent verifier rejects incomplete output and malformed contract fields', async t => {
    const f = await fixture(t), result = await packageGlide(f.options);
    assert.throws(() => validateDeliveryManifest({ ...result, indexes: [] , records: -1 }), /Invalid/);
    const directory = path.join(f.output, 'charts/glide'), page = JSON.parse(await fs.readFile(path.join(directory, result.indexes[0].file), 'utf8'));
    const invalid = structuredClone(page); invalid.archives[0].blocks[0].offset++;
    assert.throws(() => validateIndex(invalid), /Invalid|omits/);
    await fs.rm(path.join(directory, page.archives[0].file));
    await assert.rejects(verifyGlidePackages(f.output, () => {}), /ENOENT/);
    await assert.rejects(cleanGlidePackages(f.output), /refusing cleanup/);
    await packageGlide(f.options);
    await verifyGlidePackages(f.output, () => {});
});

test('region-only edits reuse payloads, split date-line regions share both sides, and coverage stays explicit', async t => {
    const f = await fixture(t, [area(-179_990_000, 35_000_000), area(179_980_000, 35_000_000)]);
    f.manifest.coverage = f.records.map((a, i) => ({ id: `side-${i}`, bounds: inspectArea(a, 8).bounds }));
    await fs.writeFile(f.manifestFile, jsonBytes(f.manifest));
    const regions = [{ id: 'islands', title: 'Both sides', bounds: [[179.9, 34.9, 180, 35.1], [-180, 34.9, -179.9, 35.1]] as [number, number, number, number][] }];
    const a = await packageGlide({ ...f.options, regions, concurrency: 1 });
    const b = await packageGlide({ ...f.options, regions: [{ ...regions[0], title: 'Renamed' }], concurrency: 4 });
    assert.deepEqual(b.indexes, a.indexes, 'region definitions do not change encoded payloads');
    assert.notEqual(b.regions[0].file, a.regions[0].file);
    const exported = path.join(f.root, 'exported');
    await exportGlidePackages(f.output, exported, () => {});
    assert.equal((await verifyGlidePackages(exported, () => {})).bytes, b.totalBytes);
    assert.equal((await fs.readdir(path.join(exported, 'charts/glide/snapshots'))).length, 1);
    await assert.rejects(exportGlidePackages(f.output, exported, () => {}), /new output directory/);
    await verifyGlidePackages(f.output, () => {});
    const directory = path.join(f.output, 'charts/glide');
    const inventory = JSON.parse(await fs.readFile(path.join(directory, b.regions[0].file), 'utf8'));
    assert.equal(inventory.files.filter(f => f.file.startsWith('detail/')).length, 2);
    assert.equal(glideRegionCoverage([[0, 0, 2, 2]], [{ bounds: [0, 0, 1, 2] }, { bounds: [1, 0, 2, 2] }]), 'available');
    assert.equal(glideRegionCoverage([[0, 0, 2, 2]], [{ bounds: [0, 0, 1, 1] }]), 'partial');
    assert.equal(glideRegionCoverage([[0, 0, 2, 2]], [{ bounds: [3, 3, 4, 4] }]), 'unavailable');
    assert.equal(glideRegionCoverage([[0, 0, 2, 2]], [{ bounds: [2, 0, 3, 2] }]), 'unavailable');
});

test('active exports are publicly readable despite private source modes and a restrictive umask', async t => {
    const f = await fixture(t); await packageGlide(f.options);
    await fs.chmod(path.join(f.output, 'charts/glide/manifest.json'), 0o600);
    const exported = path.join(f.root, 'public-export');
    await promisify(execFile)(process.execPath, ['--import=tsx', '--input-type=module', '-e',
        `import { exportGlidePackages } from './lib/glide-package-verify.ts';
        process.umask(0o077);
        await exportGlidePackages(${JSON.stringify(f.output)}, ${JSON.stringify(exported)}, () => {});`]);
    const directory = path.join(exported, 'charts/glide');
    const pending = [directory];
    while (pending.length) {
        const current = pending.pop()!;
        assert.equal((await fs.stat(current)).mode & 0o777, 0o755, current);
        for (const entry of await fs.readdir(current, { withFileTypes: true })) {
            const file = path.join(current, entry.name);
            if (entry.isDirectory()) pending.push(file);
            else assert.equal((await fs.stat(file)).mode & 0o777, 0o644, file);
        }
    }
    assert.equal((await fs.stat(path.join(f.output, 'charts/glide/manifest.json'))).mode & 0o777, 0o600);
    assert.equal((await verifyGlidePackages(exported, () => {})).records, f.records.length);
});

test('dependency pages stay bounded and regional closure rejects duplicate or omitted references', () => {
    const entry = { file: `detail/${'a'.repeat(64)}.gld`, sha256: 'a'.repeat(64), bytes: 100 };
    assert.doesNotThrow(() => validateDependencyPage({ schemaVersion: 1, files: [entry] }));
    assert.throws(() => validateDependencyPage({ schemaVersion: 1, files: [entry, entry] }), /duplicate/);
    const inventory = { schemaVersion: 1, id: 'test', title: 'Test', bounds: [[0, 0, 1, 1]], definitionSha256: '1'.repeat(64),
        sourceSha256: '2'.repeat(64), coverage: 'available', files: [], filePages: [{ file: `dependencies/${'b'.repeat(64)}.json`, sha256: 'b'.repeat(64), bytes: 100 }], indexes: [] };
    assert.doesNotThrow(() => validateRegionInventory(inventory, [entry]));
    assert.throws(() => validateRegionInventory(inventory, [entry, entry]), /duplicate/);
});

test('overview ground-area weighting handles latitude and documents narrow openings missed between samples', () => {
    const parent = new Float64Array(256 * 256 * 3), child = new Float64Array(parent.length);
    child[0] = child[3] = child[2] = child[5] = 1;
    addChildDensity(parent, child, [1, 0, 0]);
    const latitude = (row: number) => Math.tanh(Math.PI * (1 - 2 * row / 512));
    const expected = (latitude(0) - latitude(1)) / (latitude(0) - latitude(2));
    assert.ok(Math.abs(parent[0] - expected) < 1e-12);
    assert.ok(parent[0] < .5, 'northern sample row has less ground area');
    const span = 2 ** 10 * 1024, x = 200_000, y = 400_000;
    const lon = (px: number) => Math.round((px / span * 360 - 180) * 1e6);
    const lat = (py: number) => Math.round(Math.atan(Math.sinh(Math.PI * (1 - 2 * py / span))) * 180 / Math.PI * 1e6);
    // Lies between z10 sample centers (.5), while z11 has a center at .25.
    const west = lon(x + .1), east = lon(x + .4), north = lat(y), south = lat(y + 30);
    const narrow: Area = [[west, south, east, north, 60, 600, 0, 2], [[west, south, east - west, 0, 0, north - south, west - east, 0]], 0];
    assert.equal(rasterizeAreas([narrow], 10).size, 0);
    assert.ok(rasterizeAreas([narrow], 11).size > 0);
});

test('committed v1 client fixture decodes independently and retains its exact historical records', async () => {
    const output = path.resolve('test/fixtures/glide-delivery-v1'), directory = path.join(output, 'charts/glide');
    const verified = await verifyGlidePackages(output, () => {});
    assert.equal(verified.records, 2); assert.equal(verified.overviewTiles, 11);
    const expected = JSON.parse(await fs.readFile(path.join(output, 'expected-detail.json'), 'utf8'));
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
    const actual = new Map<number, Area>();
    for (const page of manifest.indexes.filter(p => p.kind === 'detail')) {
        const index = JSON.parse(await fs.readFile(path.join(directory, page.file), 'utf8'));
        for (const archive of index.archives) {
            const data = await fs.readFile(path.join(directory, archive.file)), headerSize = 16 + data.readUInt32LE(8);
            // Only the prefix and directory are needed before requesting a selected compressed range.
            const entries = readArchiveDirectory(data.subarray(0, headerSize), data.length);
            for (const block of entries) {
                const decoded = decodeDetail(data.subarray(block.offset, block.offset + block.bytes), block);
                assert.equal(decoded.source, expected.source);
                decoded.indices.forEach((id, i) => actual.set(id, decoded.areas[i]));
            }
        }
    }
    assert.deepEqual(expected.indices.map(i => actual.get(i)), expected.areas);
});

test('finer overview reuses exact detail and symlinked input locations cannot be overwritten', async t => {
    const f = await fixture(t), a = await packageGlide(f.options);
    const b = await packageGlide({ ...f.options, overviewZoom: 11 });
    assert.deepEqual(a.indexes.filter(p => p.kind === 'detail'), b.indexes.filter(p => p.kind === 'detail'));
    assert.equal(a.detailDigest, b.detailDigest);
    assert.equal(b.overview.maxZoom, 11);
    await verifyGlidePackages(f.output, () => {});
    const alias = path.join(f.root, 'alias'); await fs.mkdir(alias);
    await fs.symlink(f.manifestFile, path.join(alias, 'manifest.json'));
    await assert.rejects(packageGlide({ ...f.options, input: path.join(alias, 'manifest.json'), output: f.input }), /does not overlap/);
});
