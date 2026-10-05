import fs from 'node:fs/promises';
import path from 'node:path';
import { acquireChartBuildLock } from './chart-build-lock.ts';
import { buildFingerprint, matchesFile, readCachedJson, writeCachedJson } from './build-cache.ts';
import { sha256File, writeFileAtomic } from './fs-utils.ts';
import { mapWithConcurrency } from './concurrency.ts';
import { GdalPool } from './gdal.ts';
import { glideAnalysisFingerprints, glideAnalysisIdentity } from './glide-identity.ts';
import { glideChunks, GLIDE_RULES, type ResolvedRegion } from './glide-model.ts';
import { GlideChunkWorkers, type GlideChunkResult } from './glide-worker.ts';
import { inspectGlideVectors, prepareGlideRasters } from './glide-sources.ts';
import { validateGlideShardPatches } from './glide-shards.ts';
import { withGlideSourceCache } from './glide-download.ts';
import { readGlideAssemblyInput, writeGlideAssemblyInput, type GlideAssemblyInput } from './glide-assembly-resume.ts';

export type GlideRebuildPlan = { schemaVersion: 1; inputSha256: string; chunks: string[]; regions: ResolvedRegion[] };

/** Replay explicitly selected chunks using the exact historical source bytes.
 * Everything is staged and checked before replacing the assembly inventory.
 * No source discovery or download code is called. Completed chunks are resumable. */
export async function rebuildGlideChunks(output: string, plan: GlideRebuildPlan,
    options: { concurrency?: number; log?: (message: string) => void } = {}): Promise<void> {
    const cache = path.resolve(output, 'glide-cache'), log = options.log ?? console.log;
    const concurrency = options.concurrency ?? 16, workers = new GlideChunkWorkers(concurrency);
    const release = await acquireChartBuildLock(cache);
    let pool: GdalPool | undefined, work: string | undefined;
    try {
        if (plan.schemaVersion !== 1 || !plan.chunks.length || new Set(plan.chunks).size !== plan.chunks.length ||
            new Set(plan.regions.map(r => r.id)).size !== plan.regions.length) throw new Error('Invalid targeted rebuild plan');
        // Scope resumable outputs to the producer implementation as well as the
        // recorded sources. A code fix must not silently reuse an earlier trial.
        const producer = buildFingerprint(await Promise.all(['glide-areas', 'glide-display'].map(name =>
            fs.readFile(new URL(`./${name}.ts`, import.meta.url), 'utf8'))));
        const key = buildFingerprint({ plan, producer }), staging = path.join(cache, 'targeted-rebuild', key);
        const committed = path.join(staging, 'committed.json');
        const previousCommit = await readCachedJson<{ input: GlideAssemblyInput }>(committed, `${committed}.build.json`, key);
        let input = await readGlideAssemblyInput(cache);
        if (!input && previousCommit) {
            // JSON and receipt each replace atomically, but a stop can land
            // between them. Reconcile only the exact saved commit intent.
            const raw = JSON.parse(await fs.readFile(path.join(cache, 'assembly-input.json'), 'utf8'));
            if (buildFingerprint(raw) === buildFingerprint(previousCommit.input)) {
                await writeGlideAssemblyInput(cache, previousCommit.input);
                input = previousCommit.input;
            }
        }
        if (!input) throw new Error('Targeted rebuild requires an intact assembly inventory');
        const refreshAnalysisCache = async () => {
            const selected = new Set(plan.chunks);
            for (const region of plan.regions) for (const chunk of glideChunks(region)) if (selected.has(chunk.id)) {
                const source = path.join(staging, 'chunks', `${chunk.id}.json`);
                const result = await readCachedJson<GlideChunkResult>(source, `${source}.build.json`, buildFingerprint({ key, chunk }));
                if (!result) throw new Error(`Rebuilt chunk is missing or corrupt: ${chunk.id}`);
                const file = path.join(cache, 'analysis-v1', 'area-chunks', `${chunk.id}.json`);
                const regionFingerprint = glideAnalysisFingerprints(region, input.versions)[0];
                await writeCachedJson(file, `${file}.build.json`, buildFingerprint({ regionFingerprint, chunk }), result);
            }
        };
        if (previousCommit && input.manifest.inputSha256 === previousCommit.input.manifest.inputSha256) {
            await refreshAnalysisCache();
            log('Glide targeted rebuild: completed replacement inventory reused.'); return;
        }
        if (input.manifest.inputSha256 !== plan.inputSha256 || input.implementation !== glideAnalysisIdentity() ||
            buildFingerprint(input.manifest.rules) !== buildFingerprint(GLIDE_RULES)) throw new Error('Targeted rebuild plan no longer matches saved analysis');
        pool = await GdalPool.create(Math.min(8, concurrency), {
            tools: ['gdalinfo', 'gdalwarp', 'gdal_translate', 'gdalbuildvrt', 'ogr2ogr', 'gdal_rasterize', 'gdal'] });
        if (buildFingerprint(pool.versions) !== buildFingerprint(input.versions)) throw new Error('Targeted rebuild requires the recorded GDAL versions');
        const selected = new Set(plan.chunks), entries = input.chunks.filter(c => selected.has(c.id));
        if (entries.length !== selected.size || entries.some(c => c.kind !== 'analysis' || !c.inputSha256)) throw new Error('Rebuild plan requires saved analysis chunks');
        const byId = new Map(entries.map(c => [c.id, c]));
        const jobs = plan.regions.map(region => ({ region, chunks: [...glideChunks(region)].filter(c => selected.has(c.id)) }));
        if (jobs.some(job => !job.chunks.length) || jobs.reduce((n, j) => n + j.chunks.length, 0) !== selected.size) throw new Error('Rebuild plan does not cover every selected chunk exactly once');
        for (const { region, chunks } of jobs) for (const chunk of chunks) {
            const keys = glideAnalysisFingerprints(region, input.versions).map(regionFingerprint => buildFingerprint({ regionFingerprint, chunk }));
            if (!keys.includes(byId.get(chunk.id)!.inputSha256!)) throw new Error(`Historical source fingerprint mismatch: ${chunk.id}`);
        }
        await fs.mkdir(staging, { recursive: true });
        await writeFileAtomic(path.join(staging, 'before-input.json'), JSON.stringify(input) + '\n');
        await writeFileAtomic(path.join(staging, 'plan.json'), JSON.stringify(plan) + '\n');
        work = await fs.mkdtemp(path.join(cache, '.targeted-rebuild-'));
        const verified = new Map<string, Promise<void>>();
        const results = new Map<string, { file: string; key: string; result: GlideChunkResult }>();
        let completed = 0;
        await pool.run(() => withGlideSourceCache(() => mapWithConcurrency(jobs, Math.min(8, concurrency), async ({ region, chunks }) => {
            const directory = path.join(work!, region.id); await fs.mkdir(directory);
            try {
                // Verify each distinct asset once; source metadata was also
                // matched to the original analysis fingerprint above.
                for (const assets of Object.values(region.sources)) for (const asset of assets ?? []) {
                    const identity = buildFingerprint(asset);
                    let check = verified.get(identity);
                    if (!check) { check = (async () => {
                        if (!await matchesFile(asset.file, asset)) throw new Error(`Cached source changed: ${asset.file}`);
                    })(); verified.set(identity, check); }
                    await check;
                }
                let rasters: Awaited<ReturnType<typeof prepareGlideRasters>> | undefined;
                for (const chunk of chunks) {
                    const entry = byId.get(chunk.id)!;
                    if (!await matchesFile(path.join(cache, entry.file), entry)) throw new Error(`Original analysis changed: ${chunk.id}`);
                    const original: GlideChunkResult = JSON.parse(await fs.readFile(path.join(cache, entry.file), 'utf8'));
                    const chunkKey = buildFingerprint({ key, chunk }), file = path.join(staging, 'chunks', `${chunk.id}.json`);
                    let result = await readCachedJson<GlideChunkResult>(file, `${file}.build.json`, chunkKey);
                    if (!result) {
                        if (!rasters) { await inspectGlideVectors(region); rasters = await prepareGlideRasters(region, directory, cache); }
                        result = await workers.run({ region, chunk, sources: rasters, directory }, async () => region.sources);
                        await validateGlideShardPatches(result.areas);
                        const fits = new Set(result.areas.map(a => JSON.stringify([a[0], a[2]])));
                        if (original.areas.some(a => !fits.has(JSON.stringify([a[0], a[2]])))) {
                            throw new Error(`Targeted rebuild lost an original qualification or changed its flags: ${chunk.id}`);
                        }
                        await writeCachedJson(file, `${file}.build.json`, chunkKey, result);
                    }
                    results.set(chunk.id, { file, key: chunkKey, result });
                    log(`Glide targeted rebuild: ${++completed}/${selected.size}; ${chunk.id}: ${original.areas.length} → ${result.areas.length} valid polygons; original fits retained.`);
                }
            } finally { await fs.rm(directory, { recursive: true, force: true }); }
        })));
        // Preserve the original files before publishing replacement identities.
        // The old inventory remains resumable through before-input.json.
        const before = structuredClone(input), next = structuredClone(input);
        for (const entry of before.chunks) if (selected.has(entry.id)) {
            const backup = path.join(staging, 'originals', `${entry.id}.json`);
            await fs.mkdir(path.dirname(backup), { recursive: true });
            await fs.copyFile(path.join(cache, entry.file), backup);
            entry.file = path.relative(cache, backup);
        }
        await writeFileAtomic(path.join(staging, 'before-input.json'), JSON.stringify(before) + '\n');
        const analysisKeys = new Map(jobs.flatMap(({ region, chunks }) => chunks.map(chunk => [chunk.id,
            buildFingerprint({ regionFingerprint: glideAnalysisFingerprints(region, input.versions)[0], chunk })] as const)));
        for (const entry of next.chunks) if (selected.has(entry.id)) {
            const result = results.get(entry.id)!;
            entry.file = path.relative(cache, result.file); entry.sha256 = await sha256File(result.file);
            entry.bytes = (await fs.stat(result.file)).size;
            entry.inputSha256 = analysisKeys.get(entry.id);
        }
        for (const group of next.groups) for (const spool of group.spools) {
            if (spool.chunks.some(index => selected.has(next.chunks[index].id))) delete spool.sha256;
        }
        const oldProvenanceFile = path.join(cache, 'assembly-inputs', input.manifest.provenance.file);
        if (!await matchesFile(oldProvenanceFile, input.manifest.provenance)) throw new Error('Original source provenance is corrupt');
        const provenance = JSON.parse(await fs.readFile(oldProvenanceFile, 'utf8'));
        provenance.targetedRebuild = { producer, previousInputSha256: plan.inputSha256, chunks: plan.chunks,
            regions: plan.regions.map(region => ({ ...region, sources: Object.fromEntries(Object.entries(region.sources).map(([role, assets]) =>
                [role, assets?.map(({ file: _, ...asset }) => asset)])) })) };
        const data = JSON.stringify(provenance) + '\n', sha256 = buildFingerprint(provenance);
        // Artifact hash covers the exact bytes, including the trailing newline.
        const provenanceFile = path.join(staging, 'provenance.json'); await writeFileAtomic(provenanceFile, data);
        const artifactSha = await sha256File(provenanceFile);
        next.manifest.provenance = { file: `${artifactSha}.glide-sources.json`, sha256: artifactSha, bytes: Buffer.byteLength(data) };
        await writeFileAtomic(path.join(cache, 'assembly-inputs', next.manifest.provenance.file), data);
        next.manifest.inputSha256 = buildFingerprint({ previous: plan.inputSha256, producer, chunks: next.chunks, provenance: sha256 });
        next.manifest.generatedAt = new Date().toISOString(); next.manifest.shards = [];
        // This inventory mixes retained legacy chunks and staged replacements.
        next.recovered = true;
        // Save the commit intent first so interruption after the inventory swap
        // can finish refreshing the ordinary cache on the next invocation.
        await writeCachedJson(committed, `${committed}.build.json`, key, { input: next });
        await writeGlideAssemblyInput(cache, next);
        // Future ordinary builds must also see corrected analysis. The active
        // inventory already points at immutable staging files, so an interrupted
        // refresh of these convenience caches cannot damage assembly resumption.
        await refreshAnalysisCache();
        log(`Glide targeted rebuild complete: ${results.size} chunks replaced; ${input.chunks.length - results.size} retained. Ready for assembly-only.`);
    } finally {
        try { await workers.close(); await pool?.close(); if (work) await fs.rm(work, { recursive: true, force: true }); }
        finally { await release(); }
    }
}
