import fs from 'node:fs/promises';
import path from 'node:path';
import { GLIDE_RULES, GLIDE_VERSION, VECTOR_ROLES, expandBounds, glideChunks, type Bounds, type GlideRegion, type GlideSourceRegion, type ResolvedRegion } from './glide-model.ts';
import { buildFingerprint, readCachedJson, writeCachedJson } from './build-cache.ts';
import { glideAnalysisProfiles } from './glide-identity.ts';
import { GdalPool, gdalCommand, gdalWorkerSettings } from './gdal.ts';
import { possibleGlideChunks } from './glide-raster.ts';
import { prepareGlideRasterRole, type GlideRasterSources } from './glide-sources.ts';
import { discoverGlideCover, downloadGlideCover, GlideElevationDownloader } from './glide-raster-download.ts';
import { discoverGlideCanopy, downloadGlideCanopy, type GlideCanopyService } from './glide-canopy.ts';
import { discoverGlideShrub, downloadGlideShrub, type GlideShrubServices } from './glide-shrub.ts';
import { GlideFineCoverDownloader } from './glide-fine-cover.ts';
import type { GlideVectorDownloader } from './glide-vector-download.ts';
import { validateRegions, type OfflineRegionDefinition } from './offline-regions.ts';

export type GlideArea = Pick<GlideRegion, 'id' | 'bounds' | 'coverageBounds'>;

export function parseGlideBounds(value: string): Bounds {
    const bounds = value.split(',').map(Number) as Bounds;
    if (bounds.length !== 4 || value.split(',').some(part => !part.trim()) || !bounds.every(Number.isFinite) ||
        bounds[0] < -125 || bounds[2] > -66 || bounds[1] < 24 || bounds[3] > 50 || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) {
        throw new Error('--bbox must be west,south,east,north within CONUS (-125,24,-66,50)');
    }
    return bounds;
}

/** Default footprint comes from the repository's existing CONUS state bounds, deduplicated by degree tile. */
export async function defaultGlideAreas(bounds?: Bounds): Promise<GlideArea[]> {
    let boxes: Bounds[];
    if (bounds) boxes = [parseGlideBounds(bounds.join(','))];
    else {
        const regions: OfflineRegionDefinition[] = JSON.parse(await fs.readFile(new URL('../data/terrain-regions.json', import.meta.url), 'utf8'));
        validateRegions(regions);
        boxes = regions.filter(region => /^us-[A-Z]{2}$/.test(region.id) &&
            !['us-AK', 'us-HI', 'us-AS', 'us-GU', 'us-MP', 'us-PR', 'us-VI'].includes(region.id)).flatMap(region => region.bounds);
    }
    const areas = new Map<string, GlideArea>();
    for (const box of boxes) for (let south = Math.floor(box[1]); south < Math.ceil(box[3]); south++) {
        for (let west = Math.floor(box[0]); west < Math.ceil(box[2]); west++) {
            const id = `conus-w${-west}-n${south}`, footprint: Bounds = bounds ?
                [Math.max(west, box[0]), Math.max(south, box[1]), Math.min(west + 1, box[2]), Math.min(south + 1, box[3])] :
                [west, south, west + 1, south + 1];
            areas.set(id, { id, bounds: footprint, coverageBounds: expandBounds(footprint, GLIDE_RULES.inventoryHaloM + 10) });
        }
    }
    return [...areas.values()].sort((a, b) => a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0]);
}

type SourceOptions = { refresh?: boolean; log: (message: string) => void; concurrency?: number };

/** Shared catalogs and FAA snapshot. Call prepare before scheduling parallel region loads. */
export async function createDefaultGlideSources(output: string, options: SourceOptions) {
    const cache = path.join(path.resolve(output), 'glide-cache');
    await fs.mkdir(cache, { recursive: true });
    options.log('Glide: discovering current USGS/MRLC cover, precision elevation, Overture maps and FAA obstacles.');
    const cover = await discoverGlideCover();
    let downloads: Promise<GdalPool> | undefined;
    const downloadCommand: typeof gdalCommand = async (command, args) => {
        // Network waits must not occupy the local raster/vector preparation pool.
        downloads ??= GdalPool.create(Math.min(4, options.concurrency ?? 1), gdalWorkerSettings());
        return (await downloads).command(command, args);
    };
    const elevation = new GlideElevationDownloader(downloadCommand);
    const fineCover = new GlideFineCoverDownloader(downloadCommand);
    let canopy: Promise<GlideCanopyService> | undefined;
    let shrubs: Promise<GlideShrubServices> | undefined;
    let vectors: Promise<GlideVectorDownloader> | undefined;
    const prepareVectors = () => vectors ??= import('./glide-vector-download.ts').then(({ GlideVectorDownloader }) =>
        GlideVectorDownloader.create(cache, output, Math.min(4, options.concurrency ?? 1)));
    return {
        async prepare(): Promise<void> {
            // Spatial extension loading can deadlock with concurrent fork/exec
            // on Linux. Finish native initialization before launching GDAL jobs.
            options.log('Glide: initializing spatial database before parallel region work.');
            await prepareVectors();
            options.log('Glide: spatial database ready; regional work can start.');
        },
        async load(area: GlideArea, index: number, total: number): Promise<GlideSourceRegion | undefined> {
            const started = Date.now();
            options.log(`Glide sources ${index + 1}/${total}: ${area.id}`);
            const sources = {} as ResolvedRegion['sources'];
            // Only vectors need the large buffer for distant tall obstacles.
            const rasterBounds = expandBounds(area.bounds, GLIDE_RULES.analysisHaloM + 100);
            const work = await fs.mkdtemp(path.join(cache, '.cover-'));
            let possible = [...glideChunks({ ...area, sources })];
            let missingCover: string | undefined;
            let shrubPossible = false;
            const rasters: Partial<GlideRasterSources> = {};
            const precheck = async (role: 'landcover' | 'impervious' | 'canopy', shrubOnly = false) => {
                const gdal = gdalWorkerSettings().version ?? (await gdalCommand('gdalinfo', ['--version'])).trim();
                const keys = glideAnalysisProfiles().map(profile => buildFingerprint({ stage: 'cover-presence-v1', version: GLIDE_VERSION, ...profile,
                    gdal, role, shrubOnly, assets: sources[role].map(({ sha256, bytes }) => ({ sha256, bytes })), chunks: possible }));
                const [key] = keys;
                const file = path.join(cache, 'cover-prechecks', `${key}.json`), receipt = `${file}.build.json`;
                for (const previousKey of keys) {
                    const previousFile = path.join(cache, 'cover-prechecks', `${previousKey}.json`);
                    const saved = await readCachedJson<string[]>(previousFile, `${previousFile}.build.json`, previousKey);
                    if (saved) {
                        if (previousKey !== key) await writeCachedJson(file, receipt, key, saved);
                        return new Set(saved);
                    }
                }
                rasters[role] ??= await prepareGlideRasterRole(sources[role], role, work, cache, true);
                const retained = await possibleGlideChunks({ [role]: shrubOnly ?
                    { eligible: rasters.landcover!.shrub! } : rasters[role] }, possible, work);
                await writeCachedJson(file, receipt, key, [...retained]);
                return retained;
            };
            try {
                // Reject before acquiring DEM and vectors. Each test is optimistic:
                // no missing source family can make a candidate pass final screening.
                for (const role of ['landcover', 'impervious', 'canopy'] as const) {
                    if (role === 'canopy') {
                        canopy ??= discoverGlideCanopy();
                        sources.canopy = await downloadGlideCanopy(await canopy, rasterBounds, cache, options.refresh);
                    } else {
                        const asset = await downloadGlideCover(role, cover[role], rasterBounds, cache, options.refresh, area.coverageBounds);
                        if (!asset) { missingCover = role; break; }
                        sources[role] = [asset];
                    }
                    // Shrubland is only potential here. Detailed screening requires
                    // both numerical shrub components before it can approve a cell.
                    const retained = await precheck(role);
                    possible = possible.filter(chunk => retained.has(chunk.id));
                    if (!possible.length) break;
                }
                if (!missingCover && possible.length) shrubPossible = (await precheck('landcover', true)).size > 0;
            } finally { await fs.rm(work, { recursive: true, force: true }); }
            if (missingCover) {
                options.log(`Glide ${area.id}: outside published MRLC ${missingCover} grid; left unassessed, downloads skipped.`);
                return;
            }
            if (!possible.length) {
                options.log(`Glide ${area.id}: rejected by cover in ${((Date.now() - started) / 1000).toFixed(1)} s; DEM and hazard downloads skipped.`);
                return { ...area, sources, screenedOut: 'cover' };
            }
            if (shrubPossible) {
                shrubs ??= discoverGlideShrub();
                Object.assign(sources, await downloadGlideShrub(await shrubs, rasterBounds, cache, options.refresh));
            }
            sources.elevation = await elevation.download(rasterBounds, cache, options.refresh, area.coverageBounds);
            if (!sources.elevation.length) { options.log(`Glide: ${area.id} has no precision elevation coverage; left unassessed.`); return; }
            sources.ground = await (await prepareVectors()).downloadGround(rasterBounds, options.refresh);
            const fine = await fineCover.download(rasterBounds, cache, options.refresh);
            if (fine.length) sources.fineLandcover = fine;
            for (const role of VECTOR_ROLES) sources[role] = [];
            options.log(`Glide ${area.id}: raster sources ready in ${((Date.now() - started) / 1000).toFixed(1)} s; hazards deferred until surface screening passes.`);
            return { ...area, sources, possibleCoverChunks: possible.map(chunk => chunk.id), loadHazards: async () => {
                const hazardStart = Date.now();
                const hazards = await (await prepareVectors()).download(area.coverageBounds, options.refresh);
                options.log(`Glide ${area.id}: hazard sources ready in ${((Date.now() - hazardStart) / 1000).toFixed(1)} s.`);
                return hazards;
            } };
        },
        // The scheduler drains all region jobs before releasing shared resources.
        async close(): Promise<void> {
            try { await (await downloads?.catch(() => undefined))?.close(); }
            finally { (await vectors?.catch(() => undefined))?.close(); }
        }
    };
}

/** Serial iterator for callers that consume one region at a time. */
export async function* defaultGlideSources(output: string, areas: GlideArea[],
    options: SourceOptions): AsyncGenerator<GlideSourceRegion> {
    const sources = await createDefaultGlideSources(output, options);
    try {
        await sources.prepare();
        for (const [index, area] of areas.entries()) {
            const region = await sources.load(area, index, areas.length);
            if (region) yield region;
        }
    } finally { await sources.close(); }
}
