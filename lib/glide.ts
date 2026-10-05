import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, type Hash } from 'node:crypto';
import { acquireChartBuildLock } from './chart-build-lock.ts';
import { buildFingerprint, matchesArtifacts, matchesFile, readCachedJson, writeCachedJson } from './build-cache.ts';
import { copyFileAtomic, fileExists } from './fs-utils.ts';
import { GdalPool } from './gdal.ts';
import { mapWithConcurrency, mapWithPrefetch } from './concurrency.ts';
import { withGlideSourceCache } from './glide-download.ts';
import { GLIDE_ANALYSIS_REVISION, glideAnalysisIdentity, glideAnalysisFingerprints, readGlideAnalysis } from './glide-identity.ts';
import type { GlideChunkResult as ChunkResult } from './glide-worker.ts';
import { GLIDE_SHARD_POLICY, GLIDE_DELIVERY_VERSION } from './glide-shards.ts';
import { freezeGlideChunk, freezeGlideAnalysis, type FrozenChunk } from './glide-frozen-analysis.ts';
import { GlideAssembly, glideAssemblyConcurrency, type GlideAssemblySpool } from './glide-assembly.ts';
import { createGlideManifest, saveGlideAssemblyInput } from './glide-assembly-resume.ts';
import { glideConcurrency, glideRegionConcurrency, GlideChunkWorkers } from './glide-worker.ts';
import { type GlideScreening } from './glide-analysis.ts';
import { possibleGlideChunks } from './glide-raster.ts';
import { glideProvenance, inspectGlideVectors, prepareGlideRasters, resolveGlideSources } from './glide-sources.ts';
import { defaultGlideAreas, createDefaultGlideSources } from './glide-defaults.ts';
import { GLIDE_RULES, GLIDE_VERSION, glideChunkCount, glideChunks, validateGlideInventory,
    type Bounds, type GlideSourceRegion } from './glide-model.ts';

type Artifact = { file: string; bytes: number; sha256: string };

function screeningSummary(stats: GlideScreening | null): string {
    if (!stats) return 'no known eligible cover; terrain/hazard analysis skipped';
    const percent = (count: number) => `${(100 * count / stats.cells).toFixed(2)}%`;
    if (stats.skipped) return `rejected by ${stats.skipped}/size precheck; ` +
        `DEM known ${percent(stats.known)}, eligible cover ${percent(stats.cover)}; ` +
        `${stats.skipped === 'cover' ? 'terrain/hazard' : 'hazard'} analysis skipped`;
    const causes = (stats.hazardLosses ?? []).slice().sort((a, b) => b.cells - a.cells).slice(0, 2)
        .map(loss => `${loss.source}: ${loss.cells} terrain cells`).join(', ');
    return `best-effort mask (grid incl. halo): DEM known ${percent(stats.known)}, cover ${percent(stats.cover)}, ` +
        `hazard-free ${percent(stats.hazardFree)}, ` +
        `terrain ${percent(stats.terrain)}, qualified ground ${percent(stats.width)}; longest inspected usable run ${stats.longestUsableFt} ft (ownership-intersecting components, including their halo)` +
        (causes ? `; largest hazard exclusions (overlapping): ${causes}` : '');
}
export type GlideManifest = {
    schemaVersion: 9; builderVersion: number; generatedAt: string; inputSha256: string;
    status: 'experimental-candidates'; rules: typeof GLIDE_RULES;
    geometryMeaning: 'generalized-candidate-area';
    tuple: string[]; qualificationTuple: string[]; flagBits: Record<string, string>; provenance: Artifact;
    coverage: { id: string; bounds: Bounds; shrubEvidenceMissing?: boolean }[];
    shards: (Artifact & { id: string; bounds: Bounds; count: number; tiers: [number, number]; rawBytes: number })[];
};

function manifestBytes(manifest: GlideManifest): number {
    return Buffer.byteLength(JSON.stringify(manifest) + '\n') + manifest.provenance.bytes +
        manifest.shards.reduce((sum, shard) => sum + shard.bytes, 0);
}

export async function buildGlide(output: string, sourceFile?: string,
    options: { rebuild?: boolean; maxBytes?: number; bounds?: Bounds; refreshSources?: boolean; concurrency?: number; regionConcurrency?: number;
        assemblyConcurrency?: number;
        log?: (message: string) => void } = {}): Promise<GlideManifest> {
    const maxBytes = options.maxBytes ?? Infinity, log = options.log ?? console.log;
    if (options.maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) throw new Error('Glide size budget must be a positive byte count');
    if (sourceFile && options.bounds) throw new Error('Choose --bbox or a custom --sources inventory');
    const workers = new GlideChunkWorkers(glideConcurrency(options.concurrency));
    const regionConcurrency = glideRegionConcurrency(options.regionConcurrency, workers.concurrency);
    const assemblyConcurrency = glideAssemblyConcurrency(options.assemblyConcurrency, regionConcurrency);
    const chunksPerRegion = Math.min(workers.concurrency, Math.max(4, Math.ceil(workers.concurrency / regionConcurrency)));
    const inventory = sourceFile ? validateGlideInventory(JSON.parse(await fs.readFile(sourceFile, 'utf8'))) : undefined;
    const root = path.resolve(output), cache = path.join(root, 'glide-cache'), directory = path.join(root, 'charts', 'glide');
    const release = await acquireChartBuildLock(cache);
    let work: string | undefined;
    let automatic: Awaited<ReturnType<typeof createDefaultGlideSources>> | undefined;
    let gdal: GdalPool | undefined;
    let assemblyGdal: GdalPool | undefined;
    try {
        const implementation = await glideAnalysisIdentity();
        log(`Glide builder v${GLIDE_VERSION}: preferred canopy <=${GLIDE_RULES.maxCanopyPercent}%; mapped-open purple allowance <=${GLIDE_RULES.mappedOpenMaxCanopyPercent}%; ` +
            `analysis cache analysis-v${GLIDE_VERSION}, revision ${GLIDE_ANALYSIS_REVISION}; up to ${regionConcurrency} regions, ${workers.concurrency} shared chunk workers (${chunksPerRegion} per region).`);
        await fs.mkdir(cache, { recursive: true });
        let inputs: (() => Promise<GlideSourceRegion | undefined>)[];
        if (inventory) {
            inputs = (await resolveGlideSources(inventory, path.resolve(sourceFile), cache)).map(region => async () => region);
        } else {
            const areas = await defaultGlideAreas(options.bounds);
            automatic = await createDefaultGlideSources(root, { refresh: options.refreshSources, log, concurrency: regionConcurrency });
            await automatic.prepare();
            inputs = areas.map((area, index) => () => automatic!.load(area, index, areas.length));
        }
        // Keep native DuckDB initialization above all GDAL subprocess startup.
        gdal = await GdalPool.create(Math.min(4, regionConcurrency), { tools:
            ['gdalinfo', 'gdalwarp', 'gdal_translate', 'gdalbuildvrt', 'ogr2ogr', 'gdal_rasterize', 'gdal', 'ogrinfo'] });
        // Keep the original seven-tool fingerprint; ogrinfo is checked by the
        // shared pool as well so mixed installations cannot silently change output.
        const versions = gdal.versions.slice(0, -1);
        log(gdal.library ? 'Glide GDAL: persistent native Node workers (same screening and cache version).' :
            `Glide GDAL: CLI fallback (${gdal.fallbackReason}).`);
        return await withGlideSourceCache(() => gdal!.run(async () => {
            const manifestFile = path.join(directory, 'manifest.json'), receipt = path.join(cache, 'manifest.build.json');
            work = await fs.mkdtemp(path.join(cache, '.work-'));
            const staging = path.join(work, 'publish');
            await fs.mkdir(staging);
            const artifact = async (data: Buffer, suffix: string): Promise<Artifact> => {
                const sha256 = createHash('sha256').update(data).digest('hex'), file = `${sha256}.${suffix}`;
                await fs.writeFile(path.join(staging, file), data);
                return { file, bytes: data.length, sha256 };
            };
            const workDirectory = work;
            const missingShrubs = new Set<string>();
            const processRegion = async (region: GlideSourceRegion | undefined, regionIndex: number) => {
                if (!region) return;
                const started = Date.now();
                if ('screenedOut' in region) {
                    const frozen: FrozenChunk[] = [];
                    // glideChunks reads only id/bounds.
                    for (const chunk of glideChunks(region as Parameters<typeof glideChunks>[0])) frozen.push(await freezeGlideChunk(cache, chunk, []));
                    return { region, shards: new Map<string, GlideAssemblySpool>(), frozen };
                }
                const shards = new Map<string, { file: string; hash: Hash }>();
                const regionWork = path.join(workDirectory, `region-${regionIndex}-${region.id}`);
                await fs.mkdir(regionWork);
                let sources: Awaited<ReturnType<typeof prepareGlideRasters>> | undefined;
                let hazardsLoaded = !region.loadHazards, acquisition: Promise<void> | undefined;
                const loadHazards = () => acquisition ??= (async () => {
                    if (region.loadHazards) Object.assign(region.sources, await region.loadHazards());
                    hazardsLoaded = true;
                })();
                const groundFingerprints = glideAnalysisFingerprints(region, versions, true);
                // Candidate identities are available only after deferred hazards load.
                let regionFingerprints: string[] | undefined;
                const fingerprints = () => regionFingerprints ??= glideAnalysisFingerprints(region, versions);
                const count = glideChunkCount(region);
                const chunks = [...glideChunks(region)].map(chunk => {
                    const cached = path.join(cache, `analysis-v${GLIDE_VERSION}`, 'area-chunks', `${chunk.id}.json`);
                    const groundCache = path.join(cache, `analysis-v${GLIDE_VERSION}`, 'ground-rejections', `${chunk.id}.json`);
                    return { chunk, cached, cachedReceipt: `${cached}.build.json`, groundCache,
                        groundKeys: groundFingerprints.map(groundFingerprint => buildFingerprint({ groundFingerprint, chunk })),
                        result: undefined as ChunkResult | undefined };
                });
                for (const item of chunks) if (!options.rebuild) {
                    item.result = await readGlideAnalysis<ChunkResult>(item.groundCache, item.groundKeys);
                    if (item.result) continue;
                    // Analysis reuse requires an explicitly compatible policy and exact source identities.
                    if (!await fileExists(item.cached)) continue;
                    await loadHazards();
                    item.result = await readGlideAnalysis<ChunkResult>(item.cached,
                        fingerprints().map(regionFingerprint => buildFingerprint({ regionFingerprint, chunk: item.chunk })));
                }
                const pending = chunks.filter(item => !item.result).map(item => item.chunk);
                let possible = new Set<string>(), hazardsReady: Promise<void> | undefined;
                if (pending.length) {
                    log(`Glide ${region.id}: checking cover for ${pending.length}/${count} uncached chunks.`);
                    const coverPossible = region.possibleCoverChunks && new Set(region.possibleCoverChunks);
                    const candidates = coverPossible ? pending.filter(chunk => coverPossible.has(chunk.id)) : pending;
                    if (candidates.length) {
                        sources = await prepareGlideRasters(region, regionWork, cache);
                        possible = await possibleGlideChunks(coverPossible ? { elevation: sources.elevation } : sources,
                            candidates, regionWork);
                    }
                    log(`Glide ${region.id}: regional precheck skipped ${pending.length - possible.size}/${pending.length} chunks; ` +
                        `${possible.size} need detailed screening.`);
                }
                let completed = 0, reusedCount = 0, candidateCount = 0;
                await mapWithConcurrency(chunks, chunksPerRegion, async (item, index) => {
                    const { chunk, cached, cachedReceipt, groundCache, groundKeys, result: previous } = item;
                    let result = previous;
                    const reused = result !== undefined;
                    if (reused) reusedCount++;
                    if (result === undefined) {
                        result = { areas: [], screening: null };
                        if (possible.has(chunk.id)) {
                            try {
                                const { loadHazards: _, ...workerRegion } = region;
                                result = await workers.run({ region: workerRegion, sources: sources!, chunk, directory: regionWork }, async () => {
                                    await (hazardsReady ??= loadHazards().then(() => inspectGlideVectors(region)));
                                    return region.sources;
                                });
                            } catch (error) {
                                throw new Error(`Glide ${region.id} chunk ${index + 1}/${count} [${chunk.bounds.join(',')}]: ${(error as Error).message}`, { cause: error });
                            }
                        }
                        if (!result.areas.length && (!result.screening || result.screening.skipped)) {
                            await writeCachedJson(groundCache, `${groundCache}.build.json`, groundKeys[0], result);
                        } else {
                            if (!hazardsLoaded) throw new Error('Glide candidate analysis requires acquired hazards');
                            await writeCachedJson(cached, cachedReceipt, buildFingerprint({ regionFingerprint: fingerprints()[0], chunk }), result);
                        }
                    }
                    item.result = result;
                    completed++;
                    if (!reused && possible.has(chunk.id)) {
                        log(`Glide ${region.id} ${completed}/${count}: ${result.areas.length} candidate areas; ${screeningSummary(result.screening)}`);
                    }
                });
                if (!region.sources.shrubCover?.length || !region.sources.shrubHeight?.length) missingShrubs.add(region.id);
                // Checkpoints are committed as workers finish. Assemble shards in stable
                // chunk order so parallel scheduling cannot change geometry or output bytes.
                const frozen: FrozenChunk[] = [];
                for (const { chunk, result } of chunks) {
                    const { areas } = result!;
                    frozen.push(await freezeGlideChunk(cache, chunk, areas));
                    candidateCount += areas.length;
                    if (areas.length) {
                        let shard = shards.get(chunk.shard);
                        if (!shard) {
                            shard = { file: path.join(workDirectory, `${regionIndex}-${chunk.shard}.jsonl`), hash: createHash('sha256') };
                            shards.set(chunk.shard, shard);
                        }
                        const text = areas.map(record => JSON.stringify(record)).join('\n') + '\n';
                        await fs.appendFile(shard.file, text);
                        shard.hash.update(text);
                    }
                }
                log(`Glide ${region.id}: ${candidateCount} candidate area patches; ${count} chunks complete, ${reusedCount} cached; ` +
                    `${((Date.now() - started) / 1000).toFixed(1)} s region processing (includes any hazard acquisition).`);
                if (!hazardsLoaded) log(`Glide ${region.id}: no surface passed; all hazard acquisition skipped.`);
                const assessed: GlideSourceRegion = hazardsLoaded ? region : { id: region.id, bounds: region.bounds,
                    coverageBounds: region.coverageBounds, sources: region.sources, screenedOut: 'surface' };
                await fs.rm(regionWork, { recursive: true, force: true });
                return { region: assessed, frozen, shards: new Map([...shards].map(([id, { file, hash }]) =>
                    [id, { file, sha256: hash.digest('hex') }])) };
            };
            let completedRegions = 0;
            const results = await mapWithPrefetch(inputs, regionConcurrency, load => load(), async (region, index) => {
                const result = await processRegion(region, index);
                log(`Glide progress: ${++completedRegions}/${inputs.length} regions complete (${(100 * completedRegions / inputs.length).toFixed(1)}%).`);
                return result;
            });
            // Each region writes its own spool. Combine in input order, regardless
            // of completion order, so scheduling cannot affect provenance or geometry.
            const regions: GlideSourceRegion[] = [];
            const shards = new Map<string, GlideAssemblySpool[]>();
            for (const result of results) if (result) {
                regions.push(result.region);
                for (const [id, part] of result.shards) {
                    let shard = shards.get(id);
                    if (!shard) { shard = []; shards.set(id, shard); }
                    shard.push(part);
                }
            }
            if (!regions.length) throw new Error('No precision elevation covers the requested area; previous glide publication retained');
            const provenance = glideProvenance(regions);
            const frozenChunks = results.flatMap(result => result?.frozen ?? []);
            const inputSha256 = buildFingerprint({ delivery: GLIDE_DELIVERY_VERSION, packaging: GLIDE_SHARD_POLICY,
                version: GLIDE_VERSION, implementation, rules: GLIDE_RULES, versions, provenance });
            const current = !options.rebuild && await readCachedJson<GlideManifest>(manifestFile, receipt, inputSha256);
            if (current && await matchesArtifacts(directory, [current.provenance, ...current.shards])) {
                if (manifestBytes(current) > maxBytes) throw new Error('Existing glide publication exceeds --max-bytes');
                const frozen = await freezeGlideAnalysis(cache, current, frozenChunks,
                    await fs.readFile(path.join(directory, current.provenance.file)), implementation, directory);
                log(`Glide frozen analysis: ${frozen}`);
                log('Glide inputs and published files unchanged; reusing current manifest.');
                return current;
            }
            const provenanceArtifact = await artifact(Buffer.from(JSON.stringify({ ...provenance, tools: versions }) + '\n'), 'glide-sources.json');
            const manifest = createGlideManifest(inputSha256, provenanceArtifact,
                regions.map(({ id, bounds }) => ({ id, bounds, ...(missingShrubs.has(id) ? { shrubEvidenceMissing: true } : {}) })));
            await saveGlideAssemblyInput(cache, manifest, await fs.readFile(path.join(staging, provenanceArtifact.file)),
                implementation, versions, results.filter(result => result !== undefined), { sources: sourceFile, bounds: options.bounds });
            const assembly = new GlideAssembly(path.join(cache, `analysis-v${GLIDE_VERSION}`), workDirectory,
                { implementation, versions }, options.rebuild);
            // Screening is complete. Release its workers before starting the independently
            // bounded assembly pool, using the same verified GDAL backend/version.
            await workers.close();
            await gdal!.close();
            assemblyGdal = await GdalPool.create(assemblyConcurrency, { library: gdal!.library, version: gdal!.version });
            log(`Glide assembly: ${shards.size} spatial groups; up to ${assemblyConcurrency} groups/GDAL workers; ` +
                'checking saved groups and gzip shards before merging or compressing.');
            let assembled = 0, shardCount = 0, publicationBytes = manifestBytes(manifest);
            const assembledRegions = await assemblyGdal.run(() => mapWithConcurrency([...shards].sort(([a], [b]) => a.localeCompare(b)),
                assemblyConcurrency, async ([id, spools]) => {
                const started = Date.now();
                const result = await assembly.assemble(id, spools, batch => {
                    for (const entry of batch.shards) {
                        publicationBytes += entry.bytes + Buffer.byteLength(JSON.stringify(entry)) + Number(shardCount++ > 0);
                        if (publicationBytes > maxBytes) throw new Error(`Glide publication exceeds --max-bytes=${maxBytes} (${publicationBytes} bytes assembled); previous publication and analysis checkpoints retained`);
                    }
                    if (batch.source === 'new' || batch.source === 'merged') log(`Glide assembly ${batch.id}: ` +
                        `${batch.source === 'merged' ? 'reused merged polygons; encoded' : 'merged and encoded'} ${batch.shards.length} shards; ` +
                        `${(batch.elapsedMs / 1000).toFixed(1)} s; gzip checkpoint saved.`);
                }, message => log(`Glide assembly ${message}`));
                log(`Glide assembly: ${++assembled}/${shards.size} spatial groups complete; ${id}: ${result.shards.length} shards, ` +
                    (result.reusedGroup ? 'reused completed group' : `${result.encodedCached}/${result.batches} gzip batches reused, ${result.mergedCached} saved merges reused`) +
                    `; ${((Date.now() - started) / 1000).toFixed(1)} s; ${(publicationBytes / 1024 / 1024).toFixed(1)} MiB assembled.`);
                return result.shards;
            }));
            manifest.shards = assembledRegions.flat();
            if (manifest.shards.length > 10_000) throw new Error('Glide publication exceeds the consumer limit of 10000 shards; previous publication retained');
            if (manifestBytes(manifest) > maxBytes) throw new Error(`Glide publication exceeds --max-bytes=${maxBytes} (${publicationBytes} bytes assembled); previous publication and analysis checkpoints retained`);
            // Detect local source edits during a long build, before any manifest swap.
            const checked = new Set<string>();
            for (const region of regions) for (const assets of Object.values(region.sources)) for (const asset of assets) {
                if (!checked.has(asset.file)) {
                    if (!await matchesFile(asset.file, asset)) throw new Error(`Glide source changed during build: ${asset.name}`);
                    checked.add(asset.file);
                }
            }
            for (const item of [manifest.provenance, ...manifest.shards]) {
                const target = path.join(directory, item.file);
                const source = path.join(item === manifest.provenance ? staging : assembly.artifactDirectory, item.file);
                if (!await matchesFile(target, item)) await copyFileAtomic(source, target);
            }
            const frozen = await freezeGlideAnalysis(cache, manifest, frozenChunks,
                await fs.readFile(path.join(directory, manifest.provenance.file)), implementation, directory);
            await writeCachedJson(manifestFile, receipt, inputSha256, manifest);
            log(`Glide frozen analysis: ${frozen}`);
            log(`Glide ready: ${manifest.shards.reduce((n, shard) => n + shard.count, 0)} candidates, ` +
                `${(manifestBytes(manifest) / 1024 / 1024).toFixed(2)} MiB delivered.`);
            return manifest;
        }));
    } finally {
        try {
            await workers.close();
            await assemblyGdal?.close();
            await gdal?.close();
            await automatic?.close();
            if (work) await fs.rm(work, { recursive: true, force: true });
        }
        finally { await release(); }
    }
}

/** Explicit maintenance keeps prior generations available until the caller chooses to prune. */
export async function cleanGlide(output: string): Promise<void> {
    const cache = path.join(output, 'glide-cache'), directory = path.join(output, 'charts', 'glide');
    const release = await acquireChartBuildLock(cache);
    try {
        const file = path.join(directory, 'manifest.json');
        const manifest = JSON.parse(await fs.readFile(file, 'utf8')) as GlideManifest;
        if ((manifest as any).product === 'glide-packages') {
            const { cleanGlidePackages } = await import('./glide-packager.ts');
            await cleanGlidePackages(output); return;
        }
        if (![1, 2, 3, 4, 5, 6, 7, 8, 9].includes(manifest?.schemaVersion) || !Array.isArray(manifest.shards) ||
            !await matchesArtifacts(directory, [manifest.provenance, ...manifest.shards])) throw new Error('Invalid glide publication; refusing cleanup');
        const keep = new Set([manifest.provenance.file, ...manifest.shards.map(shard => shard.file)]);
        for (const name of await fs.readdir(directory)) {
            if (/^[a-f0-9]{64}\.glide(?:\.gz|-sources\.json)$/.test(name) && !keep.has(name)) await fs.rm(path.join(directory, name));
        }
        for (const name of await fs.readdir(cache)) {
            if (/^\.work-[A-Za-z0-9]+$/.test(name)) await fs.rm(path.join(cache, name), { recursive: true, force: true });
        }
    } finally { await release(); }
}
