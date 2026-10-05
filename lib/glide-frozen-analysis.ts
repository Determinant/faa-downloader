import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { matchesFile, readCachedJson, writeCachedJson } from './build-cache.ts';
import { copyFileAtomic, writeFileAtomic } from './fs-utils.ts';
import { artifact, hash, inspectArea, integer, jsonBytes, object, validBounds, validateSource,
    type Area, type Artifact, type SourceManifest, type SourceShard } from './glide-delivery.ts';
import type { Bounds } from './offline-regions.ts';
import type { PinnedInput } from './glide-package-input.ts';
import { compareGlideAssemblies, summarizeGlideAssembly } from './glide-assembly-comparison.ts';

export type FrozenChunk = Artifact & { id: string; group: string; bounds: Bounds; count: number; rawBytes: number };
type FrozenSource = Omit<SourceManifest, 'shards' | 'provenance'> & Pick<SourceManifest,
    'schemaVersion' | 'builderVersion' | 'inputSha256' | 'generatedAt' | 'status' | 'geometryMeaning' | 'rules' | 'coverage'>;
export type FrozenAnalysis = { product: 'glide-analysis-snapshot'; schemaVersion: 1; recordSchemaVersion: 8 | 9;
    analysisImplementation: string; source: FrozenSource;
    provenance: Artifact; baseline: SourceShard[]; chunks: FrozenChunk[]; expectedChunks: number; complete: true };

/** Export only completed results; filenames are content addressed and never replaced with a new run. */
export async function freezeGlideChunk(cache: string, chunk: { id: string; shard: string; bounds: Bounds }, areas: Area[]): Promise<FrozenChunk> {
    const raw = jsonBytes(areas);
    if (raw.length > 128 * 1024 * 1024 || areas.length > 100_000) throw new Error('Frozen analysis chunk exceeds bound');
    const data = gzipSync(raw, { level: 6 }), sha256 = hash(data), file = `objects/${sha256}.areas.gz`;
    const artifact: FrozenChunk = { file, bytes: data.length, sha256, id: chunk.id, group: chunk.shard, bounds: chunk.bounds, count: areas.length, rawBytes: raw.length };
    const target = path.join(cache, 'frozen', file);
    if (!await matchesFile(target, artifact)) await writeFileAtomic(target, data);
    return artifact;
}
export async function freezeGlideAnalysis(cache: string, manifest: SourceManifest, chunks: FrozenChunk[], provenance: Buffer,
    analysisImplementation: string, publicationDirectory: string): Promise<string> {
    const { shards: _, provenance: __, ...source } = manifest;
    const sha256 = hash(provenance), file = `objects/${sha256}.sources.json`;
    await writeFileAtomic(path.join(cache, 'frozen', file), provenance);
    for (const shard of manifest.shards) {
        const target = path.join(cache, 'frozen', shard.file);
        if (!await matchesFile(target, shard)) await copyFileAtomic(path.join(publicationDirectory, shard.file), target);
        if (!await matchesFile(target, shard)) throw new Error(`Invalid frozen assembly baseline: ${shard.file}`);
    }
    const snapshot: FrozenAnalysis = { product: 'glide-analysis-snapshot', schemaVersion: 1,
        recordSchemaVersion: manifest.schemaVersion, analysisImplementation, source, provenance: { file, bytes: provenance.length, sha256 },
        baseline: manifest.shards, chunks, expectedChunks: chunks.length, complete: true };
    validateFrozenAnalysis(snapshot);
    const data = jsonBytes(snapshot), destination = path.join(cache, 'frozen', `${hash(data)}.analysis.json`);
    await writeFileAtomic(destination, data);
    await writeFileAtomic(path.join(cache, 'frozen', 'latest.json'), data);
    return destination;
}
export function validateFrozenAnalysis(value: unknown): asserts value is FrozenAnalysis {
    if (!object(value) || value.product !== 'glide-analysis-snapshot' || value.schemaVersion !== 1 || ![8, 9].includes(value.recordSchemaVersion) ||
        value.complete !== true || typeof value.analysisImplementation !== 'string' || !/^[a-f0-9]{64}$/.test(value.analysisImplementation) ||
        !object(value.source) || value.source.schemaVersion !== value.recordSchemaVersion || !artifact(value.provenance) ||
        !Array.isArray(value.chunks) || !integer(value.expectedChunks, 1, 200_000) || value.chunks.length !== value.expectedChunks) {
        throw new Error('Expected a complete frozen analysis snapshot; a cache folder or engine version alone is insufficient');
    }
    validateSource({ ...value.source, provenance: value.provenance, shards: value.baseline });
    const ids = new Set<string>();
    for (const chunk of value.chunks) {
        if (!artifact(chunk) || !object(chunk) || !/^[a-zA-Z0-9-]{1,160}$/.test(chunk.id) || ids.has(chunk.id) ||
            !/^[a-zA-Z0-9-]{1,160}$/.test(chunk.group) || !validBounds(chunk.bounds) || !integer(chunk.count, 0, 100_000) ||
            !integer(chunk.rawBytes, 3, 128 * 1024 * 1024) || chunk.bytes > 32 * 1024 * 1024) throw new Error('Invalid or duplicate frozen analysis chunk');
        ids.add(chunk.id);
    }
}

/** Explicit assembly-only adapter. No source inventory loader, screening function or analysis worker is invoked. */
export async function reassembleFrozenGlide(inputFile: string, cache: string, log: (message: string) => void): Promise<PinnedInput> {
    const sourceBytes = await fs.readFile(inputFile);
    if (sourceBytes.length > 64 * 1024 * 1024) throw new Error('Frozen analysis manifest exceeds bound');
    const snapshot: unknown = JSON.parse(sourceBytes.toString()); validateFrozenAnalysis(snapshot);
    const snapshotHash = hash(sourceBytes), pinned = path.join(cache, 'analysis-inputs', snapshotHash);
    for (const entry of [snapshot.provenance, ...snapshot.chunks, ...snapshot.baseline]) {
        const target = path.join(pinned, entry.file);
        if (!await matchesFile(target, entry)) {
            await copyFileAtomic(path.join(path.dirname(inputFile), entry.file), target);
            if (!await matchesFile(target, entry)) throw new Error(`Invalid frozen dependency ${entry.file}; no analysis fallback`);
        }
    }
    await writeFileAtomic(path.join(pinned, 'snapshot.json'), sourceBytes);
    const implementation = createHash('sha256');
    for (const name of ['glide-frozen-analysis', 'glide-assembly-comparison', 'glide-merge', 'glide-shards', 'glide-precision', 'glide-areas']) implementation.update(name).update(await fs.readFile(new URL(`./${name}.ts`, import.meta.url)));
    const assemblyImplementation = implementation.digest('hex');
    // Load GDAL only for explicitly requested reassembly. Input rules remain historical metadata.
    const { GdalPool } = await import('./gdal.ts');
    const { mergeGlideShardPatches, encodeGlideShards, readGlidePatchBatches } = await import('./glide-shards.ts');
    const pool = await GdalPool.create(1, { tools: ['ogr2ogr'] });
    const key = hash(jsonBytes([snapshotHash, assemblyImplementation, pool.versions])), directory = path.join(cache, 'assembled-inputs', key);
    const manifestFile = path.join(directory, 'manifest.json');
    await fs.mkdir(directory, { recursive: true });
    try {
        const saved = await readCachedJson<SourceManifest>(manifestFile, `${manifestFile}.build.json`, key);
        if (saved) {
            validateSource(saved);
            let ready = true;
            for (const entry of [saved.provenance, ...saved.shards]) if (!await matchesFile(path.join(directory, entry.file), entry)) { ready = false; break; }
            if (ready) {
                log(`Glide reassembly: reused verified assembly of frozen ${snapshotHash}; zero analyzed chunks.`);
                return { manifest: saved, directory, manifestSha256: hash(await fs.readFile(manifestFile)), sourceFile: inputFile };
            }
        }
        const provenanceData = await fs.readFile(path.join(pinned, snapshot.provenance.file)), provenanceSha = hash(provenanceData);
        const provenance = { file: `${provenanceSha}.glide-sources.json`, bytes: provenanceData.length, sha256: provenanceSha };
        await writeFileAtomic(path.join(directory, provenance.file), provenanceData);
        const groups = new Map<string, FrozenChunk[]>();
        for (const chunk of snapshot.chunks) { if (!groups.has(chunk.group)) groups.set(chunk.group, []); groups.get(chunk.group)!.push(chunk); }
        const manifest: SourceManifest = { ...snapshot.source, schemaVersion: snapshot.recordSchemaVersion, provenance, shards: [],
            reassembly: { snapshotSha256: snapshotHash, originalAnalysisImplementation: snapshot.analysisImplementation,
                assemblyImplementation, tools: pool.versions, inputRecords: snapshot.chunks.reduce((n, c) => n + c.count, 0) } } as SourceManifest;
        let completed = 0;
        await pool.run(async () => {
            for (const [id, chunks] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
                const groupKey = hash(jsonBytes([key, id, chunks])), receipt = path.join(directory, 'groups', `${groupKey}.json`);
                let entries = await readCachedJson<SourceShard[]>(receipt, `${receipt}.build.json`, groupKey);
                if (entries) for (const entry of entries) if (!await matchesFile(path.join(directory, entry.file), entry)) { entries = undefined; break; }
                if (!entries) {
                    const work = await fs.mkdtemp(path.join(directory, '.assembly-'));
                    try {
                        const spool = path.join(work, 'patches.jsonl'); await fs.writeFile(spool, '');
                        for (const chunk of chunks) {
                            const raw = gunzipSync(await fs.readFile(path.join(pinned, chunk.file)), { maxOutputLength: chunk.rawBytes });
                            if (raw.length !== chunk.rawBytes) throw new Error('Frozen raw size mismatch');
                            const areas = JSON.parse(raw.toString());
                            if (!Array.isArray(areas) || areas.length !== chunk.count) throw new Error('Frozen chunk count mismatch');
                            for (const area of areas) inspectArea(area, snapshot.recordSchemaVersion);
                            if (areas.length) await fs.appendFile(spool, areas.map(a => JSON.stringify(a)).join('\n') + '\n');
                        }
                        entries = []; let batch = 0;
                        for await (const patches of readGlidePatchBatches([spool])) {
                            const batchId = `${id}-${batch++}`, report = (message: string) => log(`Glide reassembly ${batchId}: ${message}`);
                            const merged = await mergeGlideShardPatches(patches, work, report);
                            for (const { data, ...encoded } of await encodeGlideShards(batchId, merged, patches, undefined, report)) {
                                const sha256 = hash(data), file = `${sha256}.glide.gz`, entry = { ...encoded, file, sha256, bytes: data.length };
                                await writeFileAtomic(path.join(directory, file), data); entries.push(entry);
                            }
                        }
                        await writeCachedJson(receipt, `${receipt}.build.json`, groupKey, entries);
                    } finally { await fs.rm(work, { recursive: true, force: true }); }
                }
                manifest.shards.push(...entries);
                log(`Glide reassembly: ${++completed}/${groups.size} groups; ${manifest.shards.length} validated shards; no screening.`);
            }
        });
        const baseline = await summarizeGlideAssembly({ ...snapshot.source, provenance: snapshot.provenance, shards: snapshot.baseline } as SourceManifest, pinned);
        const assembled = await summarizeGlideAssembly(manifest, directory);
        (manifest.reassembly as any).comparison = compareGlideAssemblies(baseline, assembled);
        log(`Glide assembly comparison: ${JSON.stringify((manifest.reassembly as any).comparison)}`);
        validateSource(manifest);
        await writeCachedJson(manifestFile, `${manifestFile}.build.json`, key, manifest);
        return { manifest, directory, manifestSha256: hash(await fs.readFile(manifestFile)), sourceFile: inputFile };
    } finally { await pool.close(); }
}
