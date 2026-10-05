import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { acquireChartBuildLock } from './chart-build-lock.ts';
import { buildFingerprint, isRecord, matchesArtifacts, matchesFile, readCachedJson, readJson, writeCachedJson } from './build-cache.ts';
import { copyFileAtomic, fileExists, writeFileAtomic } from './fs-utils.ts';
import { mapWithConcurrency } from './concurrency.ts';
import { GdalPool } from './gdal.ts';
import { GlideAssembly, GlideAssemblyFailures, glideAssemblyConcurrency, type GlideAssemblySpool } from './glide-assembly.ts';
import { GLIDE_DELIVERY_VERSION, GLIDE_SHARD_POLICY } from './glide-shards.ts';
import { GLIDE_RULES, GLIDE_VERSION, glideChunks, validateGlideInventory, type Bounds, type GlideLandingArea } from './glide-model.ts';
import { glideAnalysisIdentity } from './glide-identity.ts';
import { defaultGlideAreas } from './glide-defaults.ts';
import { freezeGlideAnalysis, type FrozenChunk } from './glide-frozen-analysis.ts';
import type { GlideManifest } from './glide.ts';

const INPUT_KEY = buildFingerprint({ stage: 'glide-assembly-input', version: 1 });
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
type Chunk = { id: string; group: string; bounds: Bounds; file: string; sha256: string; bytes: number;
    kind: 'frozen' | 'analysis' | 'empty'; inputSha256?: string; rawBytes?: number; count?: number };
type Group = { id: string; spools: { chunks: number[]; sha256?: string }[] };
type Selection = { sources?: string; bounds?: Bounds };
type Input = { schemaVersion: 1; deliveryVersion: number; selection: Selection;
    implementation: string; versions: readonly string[]; manifest: GlideManifest;
    chunks: Chunk[]; groups: Group[]; recovered: boolean };
export type GlideAssemblyInput = Input;
/** Callers that replace an inventory must hold the glide-cache build lock. */
export async function readGlideAssemblyInput(cache: string): Promise<Input | undefined> {
    const file = inputFile(cache);
    return readCachedJson<Input>(file, `${file}.build.json`, INPUT_KEY);
}
export async function writeGlideAssemblyInput(cache: string, input: Input): Promise<void> {
    const file = inputFile(cache);
    await writeCachedJson(file, `${file}.build.json`, INPUT_KEY, input);
}
const inputFile = (cache: string) => path.join(cache, 'assembly-input.json');
const inputProvenance = (cache: string, manifest: GlideManifest) => path.join(cache, 'assembly-inputs', manifest.provenance.file);
const manifestBytes = (manifest: GlideManifest) => Buffer.byteLength(JSON.stringify(manifest) + '\n') +
    manifest.provenance.bytes + manifest.shards.reduce((n, s) => n + s.bytes, 0);

export function createGlideManifest(inputSha256: string, provenance: GlideManifest['provenance'],
    coverage: GlideManifest['coverage']): GlideManifest {
    return { schemaVersion: 9, builderVersion: GLIDE_VERSION, generatedAt: new Date().toISOString(), inputSha256,
        status: 'experimental-candidates', rules: GLIDE_RULES, geometryMeaning: 'generalized-candidate-area',
        tuple: ['qualification', 'boundaryRingsDeltaE6', 'flags'],
        flagBits: { '1': 'crop-condition-unverified', '2': 'shrub-surface-unverified', '4': 'broader-shrub-band',
            '8': 'tree-canopy-model-disagreement', '16': 'sloped-or-uneven-ground', '32': 'developed-open-space',
            '64': 'reduced-building-setback', '128': 'bare-or-mixed-open-surface-unverified',
            '256': 'constrained-footprint-or-clearance', '512': 'reduced-obstacle-exclusion', '1024': 'corroborated-cover-disagreement' },
        qualificationTuple: ['lon1E6', 'lat1E6', 'lon2E6', 'lat2E6', 'widthFt', 'usableLengthFt', 'maximumElevationM', 'tier',
            'alongGradePermille', 'crossGradePermille'], provenance, coverage, shards: [] };
}

/** Commit the complete analysis inventory BEFORE assembly can fail. Spool hashes
 * retain the normal builder's exact group keys, including region/chunk ordering. */
export async function saveGlideAssemblyInput(cache: string, manifest: GlideManifest, provenance: Buffer,
    implementation: string, versions: readonly string[], regions: {
        frozen: FrozenChunk[]; shards: Map<string, GlideAssemblySpool>;
    }[], selection: Selection = {}): Promise<void> {
    const chunks: Chunk[] = [], groups = new Map<string, Group>();
    for (const region of regions) {
        const offset = chunks.length;
        chunks.push(...region.frozen.map(chunk => ({ ...chunk, file: `frozen/${chunk.file}`, kind: 'frozen' as const })));
        for (const [id, spool] of region.shards) {
            let group = groups.get(id);
            if (!group) { group = { id, spools: [] }; groups.set(id, group); }
            group.spools.push({ sha256: spool.sha256, chunks: region.frozen.flatMap((chunk, i) => chunk.group === id ? [offset + i] : []) });
        }
    }
    await writeFileAtomic(inputProvenance(cache, manifest), provenance);
    await writeCachedJson(inputFile(cache), `${inputFile(cache)}.build.json`, INPUT_KEY,
        { schemaVersion: 1, deliveryVersion: GLIDE_DELIVERY_VERSION,
            selection: { ...selection, sources: selection.sources && path.resolve(selection.sources) },
            implementation, versions, manifest: { ...manifest, shards: [] }, chunks,
            groups: [...groups.values()], recovered: false } satisfies Input);
}

/** One-time adoption of the user's completed pre-inventory run. Pin exact local
 * checkpoint receipts, require every chunk of each included region, and leave
 * regions with no saved analysis unassessed. Never infer their empty coverage. */
export async function readCompletedGlideChunks(cache: string, sourceFile?: string, bounds?: Bounds) {
    const areas = sourceFile ? validateGlideInventory(JSON.parse(await fs.readFile(sourceFile, 'utf8'))).regions : await defaultGlideAreas(bounds);
    const directory = `analysis-v${GLIDE_VERSION}`;
    const list = async (kind: string) => {
        try { return new Set((await fs.readdir(path.join(cache, directory, kind))).filter(f => f.endsWith('.json') && !f.endsWith('.build.json'))); }
        catch (error) { if (error.code === 'ENOENT') return new Set<string>(); throw error; }
    };
    const [candidates, empty] = await Promise.all([list('area-chunks'), list('ground-rejections')]);
    const chunks: Chunk[] = [], groups: Group[] = [], coverage: GlideManifest['coverage'] = [];
    for (const area of areas) {
        const expected = [...glideChunks({ ...area, sources: {} } as Parameters<typeof glideChunks>[0])];
        if (!expected.some(c => candidates.has(`${c.id}.json`) || empty.has(`${c.id}.json`))) continue;
        const start = chunks.length;
        const saved = await mapWithConcurrency(expected, 8, async chunk => {
            const name = `${chunk.id}.json`, candidate = candidates.has(name), rejected = empty.has(name);
            if (candidate === rejected) throw new Error(`Assembly-only requires one completed checkpoint for ${chunk.id}; ` +
                `${candidate ? 'both candidate and rejection checkpoints exist' : 'checkpoint is missing'}. No analysis or download was started.`);
            const file = `${directory}/${candidate ? 'area-chunks' : 'ground-rejections'}/${name}`;
            const receipt = await readJson(path.join(cache, `${file}.build.json`));
            if (!isRecord(receipt) || receipt.schemaVersion !== 1 || !digest(receipt.inputSha256) || !digest(receipt.outputSha256)) {
                throw new Error(`Missing or invalid analysis receipt: ${file}. No analysis or download was started.`);
            }
            return { id: chunk.id, group: chunk.shard, bounds: chunk.bounds, file,
                sha256: receipt.outputSha256, bytes: (await fs.stat(path.join(cache, file))).size,
                inputSha256: receipt.inputSha256, kind: candidate ? 'analysis' : 'empty' } satisfies Chunk;
        });
        chunks.push(...saved);
        coverage.push({ id: area.id, bounds: area.bounds });
        const ids = new Set(saved.map(c => c.group));
        for (const id of ids) {
            let group = groups.find(g => g.id === id);
            if (!group) { group = { id, spools: [] }; groups.push(group); }
            group.spools.push({ chunks: saved.flatMap((c, i) => c.group === id ? [start + i] : []) });
        }
    }
    if (!chunks.length) throw new Error('No completed analysis checkpoints found for assembly-only; no downloads or analysis were started.');
    return { chunks, groups, coverage };
}

async function recoverInput(cache: string, versions: readonly string[], sourceFile: string | undefined,
    bounds: Bounds | undefined, log: (message: string) => void): Promise<Input> {
    const { chunks, groups, coverage } = await readCompletedGlideChunks(cache, sourceFile, bounds);
    const implementation = glideAnalysisIdentity(), inventorySha256 = buildFingerprint(chunks);
    // Old builders discarded source associations with the failed work directory.
    // Record this limitation rather than inventing a historical source inventory.
    const provenance = Buffer.from(JSON.stringify({ schemaVersion: 1, recovery: {
        mode: 'completed-analysis-checkpoints', inventorySha256, chunks: chunks.length,
        sourceInventoryAvailable: false,
        note: 'Resumed saved analysis without source discovery. Original per-region source associations were not retained by the older builder.' },
        regions: coverage, tools: versions }) + '\n');
    const sha256 = hash(provenance), artifact = { file: `${sha256}.glide-sources.json`, sha256, bytes: provenance.length };
    const inputSha256 = buildFingerprint({ delivery: GLIDE_DELIVERY_VERSION, packaging: GLIDE_SHARD_POLICY,
        version: GLIDE_VERSION, implementation, rules: GLIDE_RULES, versions, recoveredAnalysis: inventorySha256 });
    const manifest = createGlideManifest(inputSha256, artifact, coverage);
    const input: Input = { schemaVersion: 1, deliveryVersion: GLIDE_DELIVERY_VERSION,
        selection: { sources: sourceFile && path.resolve(sourceFile), bounds },
        implementation, versions, manifest, chunks, groups, recovered: true };
    await writeFileAtomic(inputProvenance(cache, manifest), provenance);
    await writeCachedJson(inputFile(cache), `${inputFile(cache)}.build.json`, INPUT_KEY, input);
    log(`Glide assembly-only: pinned ${chunks.length} saved chunks in ${coverage.length} complete regions; ` +
        'older-run source associations were not retained. Regions without checkpoints remain unassessed.');
    return input;
}

async function readChunk(cache: string, chunk: Chunk): Promise<GlideLandingArea[]> {
    const data = await fs.readFile(path.join(cache, chunk.file));
    if (data.length !== chunk.bytes || hash(data) !== chunk.sha256) throw new Error(`Analysis checkpoint changed or corrupt: ${chunk.id}; no analysis fallback`);
    const parsed = JSON.parse(chunk.kind === 'frozen' ? gunzipSync(data, { maxOutputLength: chunk.rawBytes }).toString() : data.toString());
    const areas = chunk.kind === 'frozen' ? parsed : parsed.areas;
    if (!Array.isArray(areas) || chunk.kind === 'empty' && areas.length ||
        chunk.kind === 'frozen' && areas.length !== chunk.count) throw new Error(`Invalid analysis checkpoint: ${chunk.id}`);
    return areas;
}

async function prepareSpools(cache: string, work: string, input: Input, group: Group): Promise<GlideAssemblySpool[]> {
    return mapWithConcurrency(group.spools, 1, async (spool, i) => {
        const file = path.join(work, `${group.id}-${i}.jsonl`), chunks = spool.chunks.map(index => input.chunks[index]);
        const key = buildFingerprint(chunks), metadata = path.join(cache, 'assembly-inputs', 'spools', `${key}.json`);
        const saved = await readCachedJson<{ sha256: string }>(metadata, `${metadata}.build.json`, key);
        let sha256 = spool.sha256 ?? (digest(saved?.sha256) ? saved.sha256 : undefined), prepared = false;
        const prepare = async () => {
            if (prepared) return;
            const hash = createHash('sha256');
            await fs.writeFile(file, '');
            for (const chunk of chunks) {
                const records = await readChunk(cache, chunk);
                if (!records.length) continue;
                const text = records.map(record => JSON.stringify(record)).join('\n') + '\n';
                await fs.appendFile(file, text); hash.update(text);
            }
            const actual = hash.digest('hex');
            if (sha256 && sha256 !== actual) throw new Error(`Assembly spool changed for ${group.id}; no analysis fallback`);
            sha256 = actual; prepared = true;
            await writeCachedJson(metadata, `${metadata}.build.json`, key, { sha256 });
        };
        if (!sha256) await prepare();
        return { file, sha256: sha256!, prepare };
    });
}

/** Exercise the publication assembler across the entire pinned inventory,
 * collecting every failed batch. Successful checkpoints remain resumable, but
 * this diagnostic never writes a publication manifest. */
export async function auditGlideAssembly(output: string, options: {
    assemblyConcurrency?: number; log?: (message: string) => void;
} = {}) {
    const log = options.log ?? console.log, concurrency = glideAssemblyConcurrency(options.assemblyConcurrency);
    const cache = path.resolve(output, 'glide-cache'), release = await acquireChartBuildLock(cache);
    let pool: GdalPool | undefined, work: string | undefined;
    try {
        const file = inputFile(cache), input = await readCachedJson<Input>(file, `${file}.build.json`, INPUT_KEY);
        if (!input) throw new Error('Assembly audit requires an intact assembly-input.json; no discovery or analysis was started');
        pool = await GdalPool.create(concurrency, { tools: ['gdalinfo', 'gdalwarp', 'gdal_translate', 'gdalbuildvrt', 'ogr2ogr', 'gdal_rasterize', 'gdal'] });
        if (input.schemaVersion !== 1 || input.implementation !== glideAnalysisIdentity() ||
            buildFingerprint(input.manifest.rules) !== buildFingerprint(GLIDE_RULES) ||
            buildFingerprint(input.versions) !== buildFingerprint(pool.versions)) {
            throw new Error('Assembly audit requires the recorded analysis policy and GDAL versions');
        }
        if (!await matchesFile(inputProvenance(cache, input.manifest), input.manifest.provenance)) throw new Error('Assembly provenance is missing or corrupt');
        work = await fs.mkdtemp(path.join(cache, '.audit-'));
        const assembly = new GlideAssembly(path.join(cache, `analysis-v${GLIDE_VERSION}`), work, input);
        const startedAt = new Date().toISOString();
        let completed = 0;
        const groups = await pool.run(() => mapWithConcurrency([...input.groups].sort((a, b) => a.id.localeCompare(b.id)), concurrency, async group => {
            const failures: { id: string; error: string; patches?: unknown }[] = [];
            let spools: GlideAssemblySpool[] = [], batches = 0, records = 0, shards = 0, bytes = 0;
            const onBatchError = (id: string, error: unknown) => {
                failures.push({ id, error: String(error),
                    ...(error instanceof Error && 'patches' in error ? { patches: error.patches } : {}) });
                log(`Glide audit FAILED ${id}: ${String(error)}`);
            };
            try {
                spools = await prepareSpools(cache, work!, input, group);
                await assembly.assemble(group.id, spools, batch => {
                    batches += batch.batches; shards += batch.shards.length;
                    records += batch.shards.reduce((n, shard) => n + shard.count, 0);
                    bytes += batch.shards.reduce((n, shard) => n + shard.bytes, 0);
                }, message => log(`Glide audit ${message}`), { onBatchError });
            } catch (error) {
                if (!(error instanceof GlideAssemblyFailures)) onBatchError(group.id, error);
            } finally { for (const spool of spools) await fs.rm(spool.file, { force: true }); }
            log(`Glide audit: ${++completed}/${input.groups.length} groups; ${group.id}: ${batches} passed batches, ${failures.length} failures.`);
            return { id: group.id, batches, records, shards, bytes, failures };
        }));
        const report = { schemaVersion: 1, inventorySha256: buildFingerprint(input), deliveryVersion: GLIDE_DELIVERY_VERSION,
            startedAt, completedAt: new Date().toISOString(), groups,
            failedBatches: groups.reduce((n, group) => n + group.failures.length, 0) };
        const reportFile = path.join(cache, 'assembly-audit.json');
        await writeFileAtomic(reportFile, JSON.stringify(report, null, 2) + '\n');
        log(`Glide audit complete: ${groups.length} groups, ${report.failedBatches} failures; ${reportFile}`);
        return report;
    } finally {
        try { await pool?.close(); if (work) await fs.rm(work, { recursive: true, force: true }); }
        finally { await release(); }
    }
}

export async function resumeGlideAssembly(output: string, options: {
    assemblyConcurrency?: number; maxBytes?: number; sources?: string; bounds?: Bounds; log?: (message: string) => void;
} = {}): Promise<GlideManifest> {
    const log = options.log ?? console.log, concurrency = glideAssemblyConcurrency(options.assemblyConcurrency);
    const maxBytes = options.maxBytes ?? Infinity, cache = path.resolve(output, 'glide-cache'), directory = path.resolve(output, 'charts/glide');
    if (options.maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) throw new Error('Glide size budget must be a positive byte count');
    const release = await acquireChartBuildLock(cache);
    let pool: GdalPool | undefined, work: string | undefined;
    try {
        log('Glide assembly-only: using saved analysis; no source discovery, source-file checks, downloads or screening.');
        pool = await GdalPool.create(concurrency, { tools: ['gdalinfo', 'gdalwarp', 'gdal_translate', 'gdalbuildvrt', 'ogr2ogr', 'gdal_rasterize', 'gdal'] });
        const file = inputFile(cache);
        let input = await readCachedJson<Input>(file, `${file}.build.json`, INPUT_KEY);
        if (!input) {
            if (await fileExists(file)) throw new Error('Assembly input inventory is corrupt; refusing to substitute other analysis checkpoints');
            input = await recoverInput(cache, pool.versions, options.sources, options.bounds, log);
        }
        if (input.schemaVersion !== 1 || input.implementation !== glideAnalysisIdentity() ||
            buildFingerprint(input.manifest.rules) !== buildFingerprint(GLIDE_RULES) ||
            buildFingerprint(input.versions) !== buildFingerprint(pool.versions)) {
            throw new Error('Saved assembly inputs require the recorded analysis policy and GDAL versions; no analysis fallback');
        }
        if (options.sources && path.resolve(options.sources) !== input.selection.sources ||
            options.bounds && buildFingerprint(options.bounds) !== buildFingerprint(input.selection.bounds ?? null)) {
            throw new Error('Assembly inventory already pins a different --sources/--bbox selection; omit selectors to resume the saved run');
        }
        if (input.deliveryVersion !== GLIDE_DELIVERY_VERSION) {
            input.manifest.inputSha256 = buildFingerprint({ previous: input.manifest.inputSha256, delivery: GLIDE_DELIVERY_VERSION });
            input.deliveryVersion = GLIDE_DELIVERY_VERSION;
            await writeCachedJson(file, `${file}.build.json`, INPUT_KEY, input);
        }
        if (!await matchesFile(inputProvenance(cache, input.manifest), input.manifest.provenance)) throw new Error('Assembly provenance is missing or corrupt');
        log(`Glide assembly-only: ${input.groups.length} groups from saved analysis inventory ${input.manifest.generatedAt}.`);
        const manifestFile = path.join(directory, 'manifest.json'), receipt = path.join(cache, 'manifest.build.json');
        const current = await readCachedJson<GlideManifest>(manifestFile, receipt, input.manifest.inputSha256);
        if (current && await matchesArtifacts(directory, [current.provenance, ...current.shards])) {
            if (manifestBytes(current) > maxBytes) throw new Error('Existing glide publication exceeds --max-bytes');
            log('Glide assembly-only: completed publication reused.'); return current;
        }
        work = await fs.mkdtemp(path.join(cache, '.assembly-'));
        const assembly = new GlideAssembly(path.join(cache, `analysis-v${GLIDE_VERSION}`), work, input);
        const manifest = { ...input.manifest, shards: [] } as GlideManifest;
        let completed = 0, bytes = manifestBytes(manifest);
        const results = await pool.run(() => mapWithConcurrency([...input.groups].sort((a, b) => a.id.localeCompare(b.id)), concurrency, async group => {
            const spools = await prepareSpools(cache, work!, input, group);
            try {
                const result = await assembly.assemble(group.id, spools, batch => {
                    for (const shard of batch.shards) bytes += shard.bytes + Buffer.byteLength(JSON.stringify(shard)) + 1;
                    if (bytes > maxBytes) throw new Error('Glide assembly exceeds --max-bytes; previous publication retained');
                    if (batch.source === 'new' || batch.source === 'merged') log(`Glide assembly ${batch.id}: ` +
                        `${batch.source === 'merged' ? 'reused merged polygons' : 'merged polygons'}; ${batch.shards.length} gzip shards saved.`);
                }, message => log(`Glide assembly ${message}`));
                log(`Glide assembly-only: ${++completed}/${input.groups.length} groups; ${group.id}: ` +
                    `${result.shards.length} shards; ${result.reusedGroup ? 'reused completed group' : `${result.encodedCached}/${result.batches} gzip batches reused`}.`);
                return result.shards;
            } finally { for (const spool of spools) await fs.rm(spool.file, { force: true }); }
        }));
        manifest.shards = results.flat();
        if (manifest.shards.length > 10_000 || manifestBytes(manifest) > maxBytes) throw new Error('Glide publication exceeds delivery limits; previous publication retained');
        for (const item of [manifest.provenance, ...manifest.shards]) {
            const source = item === manifest.provenance ? inputProvenance(cache, manifest) : path.join(assembly.artifactDirectory, item.file);
            const target = path.join(directory, item.file);
            if (!await matchesFile(target, item)) await copyFileAtomic(source, target);
        }
        if (!input.recovered) await freezeGlideAnalysis(cache, manifest, input.chunks.map(chunk => ({ ...chunk,
            file: chunk.file.slice('frozen/'.length) })) as FrozenChunk[], await fs.readFile(inputProvenance(cache, manifest)), input.implementation, directory);
        await writeCachedJson(manifestFile, receipt, manifest.inputSha256, manifest);
        log(`Glide ready: ${manifest.shards.reduce((n, s) => n + s.count, 0)} candidates; assembly-only completed.`);
        return manifest;
    } finally {
        try { await pool?.close(); if (work) await fs.rm(work, { recursive: true, force: true }); }
        finally { await release(); }
    }
}
