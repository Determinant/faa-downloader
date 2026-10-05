import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readCachedJson, writeCachedJson, matchesFile } from './build-cache.ts';
import { writeFileAtomic } from './fs-utils.ts';
import { tileBounds, tileRange } from './chart-package-grid.ts';
import { hash, jsonBytes, type Area, type Artifact, type Coverage, type StoredBlock } from './glide-delivery.ts';
import { compressBlock } from './glide-package-archive.ts';

const SIZE = 256, CELLS = SIZE * SIZE, SAMPLE = 4, EDGE = SIZE * SAMPLE;
export type Mask = Artifact & { tile: [number, number, number] };
type TileMasks = { preferred: Uint16Array; fallback: Uint16Array };
type Edge = { x: number; step: number; end: number };
const keyOf = (z: number, x: number, y: number) => `${z}/${x}/${y}`;
const project = (lon: number, lat: number, span: number) => [(lon + 180) / 360 * span,
    (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * span];
const rowArea = (row: number, span: number) => Math.tanh(Math.PI * (1 - 2 * row / span)) - Math.tanh(Math.PI * (1 - 2 * (row + 1) / span));
const bitCount = (v: number) => { v -= (v >>> 1) & 0x5555; v = (v & 0x3333) + ((v >>> 2) & 0x3333); return (((v + (v >>> 4)) & 0x0f0f) * 0x0101 >>> 8) & 255; };

/** Even-odd scan conversion at fixed sample centers. Source-shard overlaps are ORed later. */
export function rasterizeAreas(areas: Area[], zoom: number): Map<string, TileMasks> {
    const masks = new Map<string, TileMasks>(), span = 2 ** zoom * EDGE;
    for (const area of areas) {
        const buckets = new Map<number, Edge[]>();
        let first = Infinity, last = -Infinity;
        for (const ring of area[1]) {
            let lon = 0, lat = 0;
            const points: number[][] = [];
            for (let i = 0; i < ring.length; i += 2) { lon += ring[i]; lat += ring[i + 1]; points.push(project(lon / 1e6, lat / 1e6, span)); }
            for (let i = 0; i < points.length; i++) {
                let a = points[i], b = points[(i + 1) % points.length];
                if (a[1] > b[1]) [a, b] = [b, a];
                const start = Math.max(0, Math.ceil(a[1] - .5)), end = Math.min(span, Math.ceil(b[1] - .5));
                if (start >= end) continue;
                const step = (b[0] - a[0]) / (b[1] - a[1]);
                if (!buckets.has(start)) buckets.set(start, []);
                buckets.get(start)!.push({ x: a[0] + (start + .5 - a[1]) * step, step, end });
                first = Math.min(first, start); last = Math.max(last, end);
            }
        }
        let active: Edge[] = [];
        for (let row = first; row < last; row++) {
            active = active.filter(edge => edge.end > row);
            const added = buckets.get(row); if (added) active.push(...added);
            active.sort((a, b) => a.x - b.x);
            for (let i = 0; i + 1 < active.length; i += 2) {
                let start = Math.max(0, Math.ceil(active[i].x - .5));
                const end = Math.min(span, Math.ceil(active[i + 1].x - .5));
                while (start < end) {
                    const cell = Math.floor(start / SAMPLE), stop = Math.min(end, (cell + 1) * SAMPLE);
                    const tx = Math.floor(cell / SIZE), ty = Math.floor(row / EDGE), key = keyOf(zoom, tx, ty);
                    let tile = masks.get(key);
                    if (!tile) {
                        if (masks.size >= 512) throw new Error('One source shard touches too many overview tiles');
                        masks.set(key, tile = { preferred: new Uint16Array(CELLS), fallback: new Uint16Array(CELLS) });
                    }
                    const index = (Math.floor(row / SAMPLE) % SIZE) * SIZE + cell % SIZE;
                    const bits = ((1 << (stop - start)) - 1) << ((row % SAMPLE) * SAMPLE + start % SAMPLE);
                    (area[0][7] === 2 ? tile.preferred : tile.fallback)[index] |= bits;
                    start = stop;
                }
            }
            for (const edge of active) edge.x += edge.step;
        }
    }
    return masks;
}

export async function overviewMasks(areas: Area[], sourceHash: string, zoom: number, cache: string, implementation: string, force: boolean): Promise<Mask[]> {
    const identity = hash(jsonBytes([implementation, sourceHash, zoom, SAMPLE])), file = path.join(cache, 'mask-receipts', `${identity}.json`);
    const saved = !force && await readCachedJson<Mask[]>(file, `${file}.build.json`, identity);
    if (saved && Array.isArray(saved)) {
        let valid = true;
        for (const mask of saved) if (!/^masks\/[a-f0-9]{64}\.gz$/.test(mask.file) || !await matchesFile(path.join(cache, mask.file), mask)) { valid = false; break; }
        if (valid) return saved;
    }
    const result: Mask[] = [];
    for (const [key, masks] of rasterizeAreas(areas, zoom)) {
        const raw = Buffer.alloc(CELLS * 4);
        for (let i = 0; i < CELLS; i++) { raw.writeUInt16LE(masks.preferred[i], i * 4); raw.writeUInt16LE(masks.fallback[i], i * 4 + 2); }
        const data = compressBlock(raw), sha256 = hash(data), name = `masks/${sha256}.gz`;
        await writeFileAtomic(path.join(cache, name), data);
        result.push({ file: name, bytes: data.length, sha256, tile: key.split('/').map(Number) as [number, number, number] });
    }
    result.sort((a, b) => a.tile[1] - b.tile[1] || a.tile[2] - b.tile[2]);
    await writeCachedJson(file, `${file}.build.json`, identity, result); return result;
}

/** Fractions use geographic row areas; intermediate doubles avoid pyramid rounding drift. */
export function densityFractions(tile: [number, number, number], masks: TileMasks, coverage: Coverage[]): Float64Array {
    const [zoom, tx, ty] = tile, span = 2 ** zoom * EDGE, prepared = new Uint16Array(CELLS);
    for (const region of coverage) {
        const nw = project(region.bounds[0], region.bounds[3], span), se = project(region.bounds[2], region.bounds[1], span);
        const x0 = Math.max(tx * EDGE, Math.ceil(nw[0] - .5)), x1 = Math.min((tx + 1) * EDGE, Math.ceil(se[0] - .5));
        const y0 = Math.max(ty * EDGE, Math.ceil(nw[1] - .5)), y1 = Math.min((ty + 1) * EDGE, Math.ceil(se[1] - .5));
        for (let row = y0; row < y1; row++) for (let x = x0; x < x1;) {
            const cell = Math.floor(x / SAMPLE), end = Math.min(x1, (cell + 1) * SAMPLE);
            prepared[(Math.floor(row / SAMPLE) % SIZE) * SIZE + cell % SIZE] |= ((1 << (end - x)) - 1) << ((row % SAMPLE) * SAMPLE + x % SAMPLE);
            x = end;
        }
    }
    const result = new Float64Array(CELLS * 3);
    for (let y = 0; y < SIZE; y++) {
        const weights = Array.from({ length: SAMPLE }, (_, i) => rowArea(ty * EDGE + y * SAMPLE + i, span));
        const denominator = SAMPLE * weights.reduce((a, b) => a + b, 0);
        for (let x = 0; x < SIZE; x++) {
            const i = y * SIZE + x, green = masks.preferred[i], purple = masks.fallback[i] & ~green;
            const known = prepared[i] | green | purple;
            for (let row = 0; row < SAMPLE; row++) {
                const shift = row * SAMPLE, w = weights[row] / denominator;
                result[i * 3] += bitCount((green >>> shift) & 15) * w;
                result[i * 3 + 1] += bitCount((purple >>> shift) & 15) * w;
                result[i * 3 + 2] += bitCount((known >>> shift) & 15) * w;
            }
        }
    }
    return result;
}
export function addChildDensity(parent: Float64Array, child: Float64Array, tile: [number, number, number]): void {
    const [z, tx, ty] = tile, span = 2 ** z * SIZE;
    for (let y = 0; y < SIZE; y += 2) {
        const a = rowArea(ty * SIZE + y, span), b = rowArea(ty * SIZE + y + 1, span), d = 2 * (a + b);
        for (let x = 0; x < SIZE; x += 2) {
            const out = ((ty % 2 * 128 + y / 2) * SIZE + tx % 2 * 128 + x / 2) * 3;
            const input = (y * SIZE + x) * 3;
            for (let c = 0; c < 3; c++) parent[out + c] = ((child[input + c] + child[input + 3 + c]) * a +
                (child[input + SIZE * 3 + c] + child[input + SIZE * 3 + 3 + c]) * b) / d;
        }
    }
}
export function encodeDensity(values: Float64Array): Buffer {
    if (values.length !== CELLS * 3) throw new Error('Invalid density dimensions');
    const raw = Buffer.alloc(values.length);
    for (let i = 0; i < values.length; i += 3) {
        const [green, purple, prepared] = [values[i], values[i + 1], values[i + 2]];
        if (![green, purple, prepared].every(n => Number.isFinite(n) && n >= -1e-12 && n <= 1 + 1e-12) || green + purple > prepared + 1e-12) throw new Error('Invalid density fractions');
        raw[i] = Math.round(green * 255); raw[i + 1] = Math.min(255 - raw[i], Math.round(purple * 255));
        raw[i + 2] = Math.max(raw[i] + raw[i + 1], Math.round(prepared * 255));
    }
    return raw;
}

type DensityCheckpoint = { block: StoredBlock; floats: Artifact };
export async function buildOverview(masks: Mask[], coverage: Coverage[], zoom: number, cache: string, implementation: string,
    force: boolean, log: (message: string) => void): Promise<StoredBlock[]> {
    const tiles = new Map<string, Mask[]>();
    for (const mask of masks) { const key = mask.tile.join('/'); if (!tiles.has(key)) tiles.set(key, []); tiles.get(key)!.push(mask); }
    for (const region of coverage) {
        const [x0, y0, x1, y1] = tileRange(region.bounds, zoom);
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            if (tiles.size >= 100_000) throw new Error('Overview tile count exceeds build bound');
            const key = keyOf(zoom, x, y); if (!tiles.has(key)) tiles.set(key, []);
        }
    }
    const blocks: StoredBlock[] = [];
    let level = new Map<string, DensityCheckpoint>(), done = 0;
    for (const [key, parts] of [...tiles].sort(([a], [b]) => a.localeCompare(b))) {
        const tile = key.split('/').map(Number) as [number, number, number];
        const bounds = tileBounds({ z: tile[0], x: tile[1], y: tile[2] });
        const localCoverage = coverage.filter(c => c.bounds[0] < bounds[2] && c.bounds[2] > bounds[0] && c.bounds[1] < bounds[3] && c.bounds[3] > bounds[1]);
        const identity = hash(jsonBytes([implementation, tile, parts.map(p => p.sha256).sort(), localCoverage]));
        const checkpoint = await buildTile(tile, identity, async () => {
            const combined = { preferred: new Uint16Array(CELLS), fallback: new Uint16Array(CELLS) };
            for (const part of parts) {
                const data = await fs.readFile(path.join(cache, part.file));
                if (hash(data) !== part.sha256 || data.length !== part.bytes) throw new Error('Overview mask identity mismatch');
                const raw = gunzipSync(data, { maxOutputLength: CELLS * 4 });
                if (raw.length !== CELLS * 4) throw new Error('Overview mask size mismatch');
                for (let i = 0; i < CELLS; i++) { combined.preferred[i] |= raw.readUInt16LE(i * 4); combined.fallback[i] |= raw.readUInt16LE(i * 4 + 2); }
            }
            return densityFractions(tile, combined, localCoverage);
        });
        level.set(key, checkpoint); blocks.push(checkpoint.block);
        if (++done % 200 === 0) log(`Glide overview z${zoom}: ${done}/${tiles.size} tiles prepared.`);
    }
    for (let z = zoom - 1; z >= 0; z--) {
        const parents = new Map<string, [string, DensityCheckpoint][]>();
        for (const [key, checkpoint] of level) {
            const [, x, y] = key.split('/').map(Number), parent = keyOf(z, Math.floor(x / 2), Math.floor(y / 2));
            if (!parents.has(parent)) parents.set(parent, []); parents.get(parent)!.push([key, checkpoint]);
        }
        const next = new Map<string, DensityCheckpoint>();
        for (const [key, children] of [...parents].sort(([a], [b]) => a.localeCompare(b))) {
            children.sort(([a], [b]) => a.localeCompare(b));
            const tile = key.split('/').map(Number) as [number, number, number];
            const identity = hash(jsonBytes([implementation, tile, children.map(([k, c]) => [k, c.floats.sha256])]));
            const checkpoint = await buildTile(tile, identity, async () => {
                const values = new Float64Array(CELLS * 3);
                for (const [key, child] of children) {
                    const data = await fs.readFile(path.join(cache, child.floats.file));
                    if (hash(data) !== child.floats.sha256) throw new Error('Overview intermediate identity mismatch');
                    const raw = gunzipSync(data, { maxOutputLength: CELLS * 3 * 8 });
                    if (raw.length !== CELLS * 3 * 8) throw new Error('Invalid overview intermediate');
                    const childValues = new Float64Array(CELLS * 3);
                    for (let i = 0; i < childValues.length; i++) childValues[i] = raw.readDoubleLE(i * 8);
                    addChildDensity(values, childValues, key.split('/').map(Number) as [number, number, number]);
                }
                return values;
            });
            next.set(key, checkpoint); blocks.push(checkpoint.block);
        }
        log(`Glide overview z${z}: ${next.size} tiles prepared.`); level = next;
    }
    return blocks;

    async function buildTile(tile: [number, number, number], identity: string, values: () => Promise<Float64Array>): Promise<DensityCheckpoint> {
        const receipt = path.join(cache, 'density', `${identity}.json`);
        const previous = !force && await readCachedJson<DensityCheckpoint>(receipt, `${receipt}.build.json`, identity);
        if (previous && /^blocks\/[a-f0-9]{64}\.gz$/.test(previous.block?.file) && /^density-values\/[a-f0-9]{64}\.gz$/.test(previous.floats?.file) &&
            await matchesFile(path.join(cache, previous.block.file), previous.block) && await matchesFile(path.join(cache, previous.floats.file), previous.floats)) return previous;
        const fractions = await values(), raw = encodeDensity(fractions), data = compressBlock(raw), sha256 = hash(data);
        const block: StoredBlock = { key: tile.join('/'), kind: 'overview', file: `blocks/${sha256}.gz`, sha256, bytes: data.length,
            rawBytes: raw.length, bounds: tileBounds({ z: tile[0], x: tile[1], y: tile[2] }), tile,
            records: 0, vertices: 0, rings: 0, tiers: [0, 0], schema: 0 };
        await writeFileAtomic(path.join(cache, block.file), data);
        const floatRaw = Buffer.alloc(fractions.length * 8);
        for (let i = 0; i < fractions.length; i++) floatRaw.writeDoubleLE(fractions[i], i * 8);
        const floatData = compressBlock(floatRaw), floatHash = hash(floatData);
        const floats = { file: `density-values/${floatHash}.gz`, bytes: floatData.length, sha256: floatHash };
        await writeFileAtomic(path.join(cache, floats.file), floatData);
        const result = { block, floats }; await writeCachedJson(receipt, `${receipt}.build.json`, identity, result); return result;
    }
}
