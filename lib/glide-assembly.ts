import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseConcurrency } from './concurrency.ts';
import { buildFingerprint, matchesArtifacts, matchesFile, readCachedJson, writeCachedJson } from './build-cache.ts';
import { writeFileAtomic } from './fs-utils.ts';
import { GLIDE_RULES, GLIDE_VERSION, type GlideLandingArea } from './glide-model.ts';
import { GLIDE_SHARD_POLICY, GLIDE_DELIVERY_VERSION, encodeGlideShards, mergeGlideShardPatches, readGlidePatchBatches,
    validateGlideShardPatches, InvalidGlideGeometry, type EncodedGlideShard } from './glide-shards.ts';

export type GlideAssemblySpool = { file: string; sha256: string; prepare?: () => Promise<void> };
export type AssembledGlideShard = Omit<EncodedGlideShard, 'data'> & { file: string; bytes: number; sha256: string };
type Checkpoint = { batches: number; shards: AssembledGlideShard[] };
type Progress = Checkpoint & { id: string; source: 'group' | 'encoded' | 'merged' | 'new'; elapsedMs: number };
type Result = Checkpoint & { reusedGroup: boolean; encodedCached: number; mergedCached: number };

export class GlideAssemblyFailures extends AggregateError {
    constructor(readonly batches: { id: string; error: unknown }[]) {
        super(batches.map(batch => batch.error), `Glide assembly failed in ${batches.length} batches: ` +
            batches.map(batch => `${batch.id}: ${String(batch.error)}`).join('\n'));
    }
}

// Screening identities remain unchanged. Legacy delivery with invalid originals
// must recheck union completeness and precision recovery before being adopted.
const ASSEMBLY_VERSION = GLIDE_DELIVERY_VERSION;

/** Scheduling only: changing worker count must not invalidate any checkpoints. */
export function glideAssemblyConcurrency(requested?: number, regions = 4): number {
    return requested === undefined ? Math.min(4, regions) : parseConcurrency(requested, '--assembly-concurrency');
}

export class GlideAssembly {
    readonly artifactDirectory: string;
    private inputs: { packaging: typeof GLIDE_SHARD_POLICY; version: number; implementation: string;
        rules: typeof GLIDE_RULES; versions: readonly string[] };
    private inputSha256: string;

    constructor(private cache: string, private workDirectory: string,
        inputs: { implementation: string; versions: readonly string[] }, private rebuild = false) {
        this.artifactDirectory = path.join(cache, 'assembly', 'artifacts');
        this.inputs = { packaging: GLIDE_SHARD_POLICY, version: GLIDE_VERSION,
            implementation: inputs.implementation, rules: GLIDE_RULES, versions: inputs.versions };
        this.inputSha256 = buildFingerprint(this.inputs);
    }

    private async read(file: string, key: string): Promise<Checkpoint | undefined> {
        if (this.rebuild) return;
        const cached = await readCachedJson<Checkpoint>(file, `${file}.build.json`, key);
        if (!cached || !Number.isSafeInteger(cached.batches) || cached.batches < 0 || !Array.isArray(cached.shards)) return;
        // Cleanup may legitimately leave an entire batch/group empty. Preserve
        // that completed work just like a group with zero analyzed candidates.
        if (cached.shards.length && (cached.batches === 0 ||
            !await matchesArtifacts(this.artifactDirectory, cached.shards))) return;
        return cached;
    }

    /** Spool hashes come from the exact bytes written in stable region/chunk order.
     * Check completed groups before parsing polygons; commit each encoded batch
     * before reporting progress so an interruption loses at most the current batch. */
    async assemble(id: string, spools: GlideAssemblySpool[],
        progress: (batch: Progress) => void = () => {}, log: (message: string) => void = () => {},
        audit?: { onBatchError: (id: string, error: unknown) => void }): Promise<Result> {
        const started = Date.now();
        const groupFile = path.join(this.cache, 'assembly', 'groups', `${id}.json`);
        const groupKey = buildFingerprint({ assembly: ASSEMBLY_VERSION, id, inputs: this.inputSha256,
            spools: spools.map(spool => spool.sha256) });
        const group = await this.read(groupFile, groupKey);
        if (group) {
            progress({ ...group, id, source: 'group', elapsedMs: Date.now() - started });
            return { ...group, reusedGroup: true, encodedCached: group.batches, mergedCached: 0 };
        }
        const shards: AssembledGlideShard[] = [];
        const failures: { id: string; error: unknown }[] = [];
        let batches = 0, encodedCached = 0, mergedCached = 0;
        for (const spool of spools) await spool.prepare?.();
        for await (const patches of readGlidePatchBatches(spools.map(spool => spool.file))) {
            const batchStarted = Date.now(), batchId = `${id}-${batches++}`;
            const legacyMergeKey = buildFingerprint({ ...this.inputs, patches: buildFingerprint(patches) });
            const mergeKey = buildFingerprint({ merge: 2, input: legacyMergeKey });
            const encodedKey = buildFingerprint({ assembly: ASSEMBLY_VERSION, id: batchId, merge: mergeKey });
            const encodedFile = path.join(this.cache, 'assembly', 'batches', `${batchId}.json`);
            let encoded = await this.read(encodedFile, encodedKey);
            let source: Progress['source'] = 'encoded';
            const mergedFile = path.join(this.cache, 'area-shards', `${batchId}.json`);
            let legacyRecords: GlideLandingArea[] | undefined;
            if (!encoded && !this.rebuild) {
                const previous = await this.read(encodedFile, buildFingerprint({ assembly: 2, id: batchId, merge: legacyMergeKey }));
                legacyRecords = !previous ? await readCachedJson<GlideLandingArea[]>(mergedFile, `${mergedFile}.build.json`, legacyMergeKey) : undefined;
                if (previous || legacyRecords) {
                    try {
                        // A union of valid connected originals cannot create a
                        // disconnected piece without an original qualification.
                        // Invalid originals require the new precision policy;
                        // old valid-looking unions could have omitted fragments.
                        await validateGlideShardPatches(patches);
                        if (previous) {
                            encoded = previous;
                            await writeCachedJson(encodedFile, `${encodedFile}.build.json`, encodedKey, previous);
                        }
                    } catch (error) {
                        if (!(error instanceof InvalidGlideGeometry)) throw error;
                        legacyRecords = undefined;
                    }
                }
            }
            if (encoded) encodedCached++;
            else {
                try {
                    let records = !this.rebuild && await readCachedJson<GlideLandingArea[]>(mergedFile, `${mergedFile}.build.json`, mergeKey);
                    records ||= legacyRecords;
                    if (records) { mergedCached++; source = 'merged'; }
                    else {
                        source = 'new';
                        records = await mergeGlideShardPatches(patches, this.workDirectory, message => log(`${batchId}: ${message}`));
                        await writeCachedJson(mergedFile, `${mergedFile}.build.json`, mergeKey, records);
                    }
                    encoded = { batches: 1, shards: [] };
                    for (const { data, ...metadata } of await encodeGlideShards(batchId, records, patches, GLIDE_SHARD_POLICY,
                        message => log(`${batchId}: ${message}`))) {
                        const sha256 = createHash('sha256').update(data).digest('hex'), file = `${sha256}.glide.gz`;
                        const entry = { ...metadata, file, bytes: data.length, sha256 };
                        const destination = path.join(this.artifactDirectory, file);
                        if (!await matchesFile(destination, entry)) await writeFileAtomic(destination, data);
                        encoded.shards.push(entry);
                    }
                    await writeCachedJson(encodedFile, `${encodedFile}.build.json`, encodedKey, encoded);
                } catch (error) {
                    if (!audit) throw error;
                    // Audits inspect later batches too, but a failed group can
                    // never receive a completion receipt or be published.
                    failures.push({ id: batchId, error });
                    audit.onBatchError(batchId, error);
                    continue;
                }
            }
            shards.push(...encoded.shards);
            progress({ ...encoded, id: batchId, source, elapsedMs: Date.now() - batchStarted });
        }
        if (failures.length) throw new GlideAssemblyFailures(failures);
        const result = { batches, shards };
        await writeCachedJson(groupFile, `${groupFile}.build.json`, groupKey, result);
        return { ...result, reusedGroup: false, encodedCached, mergedCached };
    }
}
