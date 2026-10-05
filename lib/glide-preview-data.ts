import fs from 'node:fs/promises';
import path from 'node:path';
import { readCachedJson } from './build-cache.ts';
import { mapWithConcurrency } from './concurrency.ts';
import { glideAreaPolygon } from './glide-areas.ts';
import { GLIDE_VERSION, GLIDE_RULES, expandBounds, type Bounds, type GlideLandingArea } from './glide-model.ts';

const MAX_DETAIL_CHUNKS = 256;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
// Development snapshots remain inspectable after resetting the release to v1.
export const supportedVersion = (version: number) => Number.isInteger(version) &&
    (version === GLIDE_VERSION || version >= 14 && version <= 20);
type Feature = { type: 'Feature'; id: string; bbox: Bounds; geometry: ReturnType<typeof glideAreaPolygon>;
    properties: { tier: number; flags: number; lengthFt: number; widthFt: number; elevationM: number; fitCenter: [number, number];
        alongGradePercent?: number; crossGradePercent?: number } };
type Chunk = { id: string; bounds: Bounds; files: string[] };
type Sample = { id: string; title: string; center: [number, number]; zoom: number; generatedAt: string;
    version: number; features: Feature[]; bounds?: Bounds };
type SampleSummary = Omit<Sample, 'features'> & { count: number };
type Candidate = { file: string; time: number; bytes: number; stamp: string; modified: number };
class InvalidSample extends Error {}
const overlaps = (a: Bounds, b: Bounds) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

/** Current labels follow engine rules; historical labels retain their original thresholds. */
export function previewLabels(version: number) {
    const current = version === GLIDE_VERSION;
    const preferred = current ? GLIDE_RULES.tiers[1].minimumLengthFt : version >= 15 ? 2000 : 3000;
    return { preferred: `At least one ${preferred.toLocaleString('en-US')} ft fit`,
        fallback: current ? `Measured fits · ${GLIDE_RULES.tiers[0].minimumLengthFt}+ ft × ${GLIDE_RULES.fallbackMinimumWidthFt}+ ft`
            : version >= 20 ? 'Measured fits · 600+ ft × 60+ ft' : 'At least one 1,500 ft fit' };
}

/** Metadata survives between listings; geometry is loaded only for the requested sample. */
export class GlidePreviewSamples {
    private summaries = new Map<string, { stamp: string; summary: SampleSummary }>();
    constructor(private output: string) {}
    private file(id: string): string {
        if (!/^[a-z0-9-]+$/.test(id)) throw new Error('Invalid saved sample ID');
        return path.join(this.output, 'glide-preview', 'samples', `${id}.json`);
    }
    async get(id: string): Promise<Sample> {
        const sample = JSON.parse(await fs.readFile(this.file(id), 'utf8')) as Sample;
        if (!sample || sample.id !== id || !supportedVersion(sample.version) || !Array.isArray(sample.features)) throw new InvalidSample('Invalid saved sample');
        return sample;
    }
    async list(): Promise<SampleSummary[]> {
        const directory = path.join(this.output, 'glide-preview', 'samples');
        const files = await fs.readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
        const summaries: SampleSummary[] = [], present = new Set<string>();
        for (const file of files.filter(name => /^[a-z0-9-]+\.json$/.test(name)).sort()) {
            const id = file.slice(0, -5); present.add(id);
            try {
                const stat = await fs.stat(this.file(id)), stamp = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
                let entry = this.summaries.get(id);
                if (entry?.stamp !== stamp) {
                    const { features, ...sample } = await this.get(id);
                    entry = { stamp, summary: { ...sample, count: features.length } }; this.summaries.set(id, entry);
                }
                summaries.push(entry.summary);
            } catch (error) {
                // A sample may be replaced while the review tool is still writing it.
                if (error.code !== 'ENOENT' && !(error instanceof SyntaxError) && !(error instanceof InvalidSample)) throw error;
                this.summaries.delete(id);
            }
        }
        for (const id of this.summaries.keys()) if (!present.has(id)) this.summaries.delete(id);
        return summaries;
    }
}

export function previewFeature(area: GlideLandingArea, id: string): Feature {
    const q = area[0], geometry = glideAreaPolygon(area), bbox: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
    for (const ring of geometry.coordinates) for (const [x, y] of ring) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Invalid candidate coordinates');
        bbox[0] = Math.min(bbox[0], x); bbox[1] = Math.min(bbox[1], y);
        bbox[2] = Math.max(bbox[2], x); bbox[3] = Math.max(bbox[3], y);
    }
    if (![1, 2].includes(q[7]) || !bbox.every(Number.isFinite)) throw new Error('Invalid candidate area');
    return { type: 'Feature', id, bbox, geometry, properties: {
        tier: q[7], flags: area[2], lengthFt: q[5], widthFt: q[4], elevationM: q[6], fitCenter: [(q[0] + q[2]) / 2e6, (q[1] + q[3]) / 2e6],
        ...(q.length === 10 ? { alongGradePercent: q[8]! / 10, crossGradePercent: q[9]! / 10 } : {}) } };
}

export function previewBounds(text: string | null): Bounds {
    const parts = text?.split(',') ?? [], b = parts.map(Number) as Bounds;
    if (parts.length !== 4 || parts.some(p => !p.trim()) || !b.every(Number.isFinite) ||
        b[0] < -180 || b[2] > 180 || b[1] < -85 || b[3] > 85 || b[0] >= b[2] || b[1] >= b[3]) {
        throw new Error('Expected bbox=west,south,east,north within map bounds');
    }
    return b;
}

/** Read-only preview: no source acquisition, raster processing, or writes to build caches. */
export class GlidePreviewData {
    private index = new Map<string, Chunk>();
    private scanned = 0;
    private scanning?: Promise<void>;
    private cached = new Map<string, { stamp: string; bytes: number; features: Feature[] }>();
    private loading = new Map<string, Promise<Feature[] | undefined>>();
    private receipts = new Map<string, { stamp: string; inputSha256?: string }>();
    private cacheBytes = 0;
    readonly directory: string;
    constructor(readonly output: string, readonly version = GLIDE_VERSION, private samples = new GlidePreviewSamples(output)) {
        this.directory = path.join(output, 'glide-cache', `analysis-v${version}`);
    }
    private async refresh(): Promise<void> {
        if (Date.now() - this.scanned < 15_000) return;
        if (this.scanning) return this.scanning;
        this.scanning = (async () => {
            const index = new Map<string, Chunk>();
            for (const family of ['area-chunks', 'ground-rejections']) {
                const dir = path.join(this.directory, family);
                const files = await fs.readdir(dir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
                for (const file of files) {
                    const match = file.match(/^([a-z0-9][a-z0-9-]{0,79}?)-(-?\d+)-(-?\d+)\.json$/);
                    if (!match) continue;
                    const x = Number(match[2]), y = Number(match[3]), id = file.slice(0, -5);
                    const chunk = index.get(id) ?? { id, bounds: [x / 8, y / 8, (x + 1) / 8, (y + 1) / 8] as Bounds, files: [] };
                    chunk.files.push(path.join(dir, file)); index.set(id, chunk);
                }
            }
            this.index = index; this.scanned = Date.now();
        })();
        try { await this.scanning; } finally { this.scanning = undefined; }
    }
    private async candidates(chunk: Chunk): Promise<Candidate[]> {
        return (await Promise.all(chunk.files.map(async file => {
            try {
                const [data, receipt] = await Promise.all([fs.stat(file), fs.stat(`${file}.build.json`)]);
                return { file, time: receipt.mtimeMs, bytes: data.size, modified: data.mtimeMs,
                    stamp: `${data.size}:${data.mtimeMs}:${data.ctimeMs}:${receipt.mtimeMs}:${receipt.ctimeMs}` };
            } catch (error) { if (error.code === 'ENOENT') return; throw error; }
        }))).filter(value => value !== undefined).sort((a, b) => b.time - a.time);
    }
    private async receipt(candidate: Candidate): Promise<string | undefined> {
        const previous = this.receipts.get(candidate.file);
        if (previous?.stamp === candidate.stamp) return previous.inputSha256;
        let inputSha256: string | undefined;
        try {
            const value = JSON.parse(await fs.readFile(`${candidate.file}.build.json`, 'utf8'));
            if (candidate.time >= candidate.modified && value?.schemaVersion === 1 &&
                /^[a-f0-9]{64}$/.test(value.inputSha256) && /^[a-f0-9]{64}$/.test(value.outputSha256)) inputSha256 = value.inputSha256;
        } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        this.receipts.set(candidate.file, { stamp: candidate.stamp, inputSha256 }); return inputSha256;
    }
    private async committed(chunk: Chunk): Promise<boolean> {
        // Overview checks small commit receipts, not national geometry. Detail also verifies the content hash.
        for (const candidate of await this.candidates(chunk)) if (await this.receipt(candidate)) return true;
        return false;
    }
    private async chunk(chunk: Chunk): Promise<Feature[] | undefined> {
        const pending = this.loading.get(chunk.id);
        if (pending) return pending;
        const load = this.loadChunk(chunk); this.loading.set(chunk.id, load);
        try { return await load; } finally { this.loading.delete(chunk.id); }
    }
    private async loadChunk(chunk: Chunk): Promise<Feature[] | undefined> {
        // If both families exist, the most recent committed result takes precedence.
        for (const candidate of await this.candidates(chunk)) {
            const inputSha256 = await this.receipt(candidate);
            if (!inputSha256) continue;
            const previous = this.cached.get(candidate.file);
            if (previous?.stamp === candidate.stamp) {
                this.cached.delete(candidate.file); this.cached.set(candidate.file, previous);
                return previous.features;
            }
            try {
                const data = await readCachedJson<{ areas: GlideLandingArea[] }>(candidate.file,
                    `${candidate.file}.build.json`, inputSha256);
                if (!data || !Array.isArray(data.areas)) {
                    this.receipts.set(candidate.file, { stamp: candidate.stamp }); continue;
                }
                const features = data.areas.map((area, i) => previewFeature(area, `${chunk.id}:${i}`));
                const replaced = this.cached.get(candidate.file);
                if (replaced) { this.cacheBytes -= replaced.bytes; this.cached.delete(candidate.file); }
                if (candidate.bytes <= MAX_CACHE_BYTES) {
                    while (this.cacheBytes + candidate.bytes > MAX_CACHE_BYTES && this.cached.size) {
                        const key = this.cached.keys().next().value!;
                        this.cacheBytes -= this.cached.get(key)!.bytes; this.cached.delete(key);
                    }
                    this.cached.set(candidate.file, { ...candidate, features }); this.cacheBytes += candidate.bytes;
                }
                return features;
            } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        }
    }
    async view(bounds: Bounds, zoom: number, sampleId?: string | null) {
        if (sampleId) {
            const sample = await this.samples.get(sampleId);
            return { type: 'FeatureCollection', features: sample.features.filter(f => overlaps(f.bbox, bounds)), coverage: [],
                meta: { source: 'sample', title: sample.title, timestamp: sample.generatedAt, version: sample.version, currentVersion: GLIDE_VERSION,
                    sampleCount: sample.features.length, labels: previewLabels(sample.version),
                    analyzedInView: sample.bounds ? overlaps(previewBounds(sample.bounds.join(',')), bounds) : undefined,
                    mode: 'detail', checkpointCount: 0, visibleChunks: 0, pendingChunks: 0, grid: 'chunk' } };
        }
        await this.refresh();
        // A patch may extend beyond its owning chunk, so include the analysis halo.
        const query = expandBounds(bounds, GLIDE_RULES.analysisHaloM + 50);
        const visible = [...this.index.values()].filter(chunk => overlaps(chunk.bounds, query));
        const overview = zoom < 9 || visible.length > MAX_DETAIL_CHUNKS;
        const coverage: { bounds: Bounds; count: number }[] = [], features: Feature[] = [];
        let pendingChunks = 0;
        if (overview) {
            const regions = new Map<string, { bounds: Bounds; count: number }>();
            const complete = await mapWithConcurrency(visible, 8, async chunk => ({ chunk, committed: await this.committed(chunk) }));
            for (const { chunk, committed } of complete) {
                if (!committed) { pendingChunks++; continue; }
                const w = Math.floor(chunk.bounds[0]), s = Math.floor(chunk.bounds[1]), key = `${w},${s}`;
                const region = regions.get(key) ?? { bounds: [w, s, w + 1, s + 1] as Bounds, count: 0 };
                region.count++; regions.set(key, region);
            }
            coverage.push(...regions.values());
        } else {
            const chunks = await mapWithConcurrency(visible, 4, async chunk => ({ chunk, areas: await this.chunk(chunk) }));
            for (const { chunk, areas } of chunks) {
                if (!areas) { pendingChunks++; continue; }
                coverage.push({ bounds: chunk.bounds, count: 1 });
                features.push(...areas.filter(feature => overlaps(feature.bbox, bounds)));
            }
        }
        return { type: 'FeatureCollection', features, coverage, meta: { source: 'live', title: 'Live build checkpoints',
            timestamp: new Date().toISOString(), version: this.version, currentVersion: GLIDE_VERSION, mode: overview ? 'overview' : 'detail',
            checkpointCount: this.index.size, visibleChunks: coverage.reduce((n, c) => n + c.count, 0), pendingChunks, labels: previewLabels(this.version),
            grid: overview ? 'region' : 'chunk' } };
    }
}
