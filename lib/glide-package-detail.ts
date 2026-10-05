import fs from 'node:fs/promises';
import path from 'node:path';
import { tileRange } from './chart-package-grid.ts';
import { readCachedJson, writeCachedJson, matchesFile } from './build-cache.ts';
import { writeFileAtomic } from './fs-utils.ts';
import { DELIVERY_LIMITS as L, hash, inspectArea, jsonBytes, unionBounds, type Area, type SourceShard, type StoredBlock } from './glide-delivery.ts';
import { compressBlock, decodeDetail, encodeDetail } from './glide-package-archive.ts';

export async function packageDetailShard(areas: Area[], source: SourceShard, schema: 8 | 9, cache: string,
    implementation: string, force = false): Promise<StoredBlock[]> {
    const key = hash(jsonBytes([implementation, source.sha256, schema, L])), receipt = path.join(cache, 'detail', `${key}.json`);
    const previous = !force && await readCachedJson<StoredBlock[]>(receipt, `${receipt}.build.json`, key);
    if (previous && await verify(previous)) return previous;
    const info = areas.map(area => inspectArea(area, schema));
    const groups = new Map<string, number[]>();
    for (let i = 0; i < areas.length; i++) {
        const q = areas[i][0], lon = (q[0] + q[2]) / 2e6, lat = (q[1] + q[3]) / 2e6;
        const [x, y] = tileRange([lon, lat, lon + 1e-9, lat + 1e-9], 10);
        const tile = `10/${x}/${y}`;
        if (!groups.has(tile)) groups.set(tile, []);
        groups.get(tile)!.push(i);
    }
    const blocks: StoredBlock[] = [];
    const encode = async (indices: number[], tile: [number, number, number], suffix: string): Promise<void> => {
        const records = indices.map(i => areas[i]), bounds = unionBounds(indices.map(i => info[i].bounds));
        const vertices = indices.reduce((n, i) => n + info[i].vertices, 0), rings = indices.reduce((n, i) => n + info[i].rings, 0);
        const raw = encodeDetail({ source: source.sha256, indices, areas: records });
        const singleton = indices.length === 1;
        if (raw.length <= (singleton ? L.oversizedBlockRawBytes : L.blockRawBytes) && vertices <= (singleton ? L.oversizedVertices : L.vertices) &&
            rings <= (singleton ? L.oversizedRings : L.rings) && indices.length <= L.records) {
            const data = compressBlock(raw);
            const oversized = singleton && (raw.length > L.blockRawBytes || vertices > L.vertices || rings > L.rings || data.length > L.blockBytes);
            if (data.length <= (oversized ? L.oversizedBlockBytes : L.blockBytes)) {
                const sha256 = hash(data), file = `blocks/${sha256}.gz`, tiers: [number, number] = [0, 0];
                for (const area of records) tiers[area[0][7] - 1]++;
                const block: StoredBlock = { key: `${source.sha256}/${tile.join('/')}/${suffix}`, kind: 'detail', file, bounds,
                    rawBytes: raw.length, bytes: data.length, sha256, records: records.length, vertices, rings, tiers, schema, tile,
                    ...(oversized ? { oversized: true as const } : {}) };
                // Verify the actual decoder output before checkpointing, including IDs and all tuple values.
                const decoded = decodeDetail(data, block);
                if (JSON.stringify(decoded) !== JSON.stringify({ source: source.sha256, indices, areas: records })) throw new Error('Lossless detail verification failed');
                await writeFileAtomic(path.join(cache, file), data); blocks.push(block); return;
            }
        }
        if (indices.length === 1) throw new Error(`Indivisible glide record ${source.sha256}:${indices[0]} exceeds delivery limits (${vertices} vertices, ${raw.length} raw bytes); input retained`);
        const axis = (bounds[2] - bounds[0]) * Math.cos((bounds[1] + bounds[3]) * Math.PI / 360) >= bounds[3] - bounds[1] ? 0 : 1;
        const center = (i: number, a: number) => (info[i].bounds[a] + info[i].bounds[a + 2]) / 2;
        const sorted = indices.slice().sort((a, b) => center(a, axis) - center(b, axis) || center(a, 1 - axis) - center(b, 1 - axis) || a - b);
        const middle = Math.floor(sorted.length / 2);
        await encode(sorted.slice(0, middle), tile, `${suffix}0`); await encode(sorted.slice(middle), tile, `${suffix}1`);
    };
    for (const [tile, indices] of [...groups].sort(([a], [b]) => a.localeCompare(b))) await encode(indices, tile.split('/').map(Number) as [number, number, number], 'r');
    if (!await verify(blocks)) throw new Error('Incomplete detail checkpoint');
    await writeCachedJson(receipt, `${receipt}.build.json`, key, blocks);
    return blocks;

    async function verify(entries: StoredBlock[]): Promise<boolean> {
        if (!Array.isArray(entries)) return false;
        const seen = new Uint8Array(areas.length);
        try {
            for (const block of entries) {
                if (!/^blocks\/[a-f0-9]{64}\.gz$/.test(block.file) || !await matchesFile(path.join(cache, block.file), block)) return false;
                const value = decodeDetail(await fs.readFile(path.join(cache, block.file)), block);
                if (value.source !== source.sha256) return false;
                for (let i = 0; i < value.indices.length; i++) {
                    const index = value.indices[i];
                    if (index >= areas.length || seen[index] || JSON.stringify(value.areas[i]) !== JSON.stringify(areas[index])) return false;
                    seen[index] = 1;
                }
            }
            return seen.every(n => n === 1);
        } catch (error) { if (error.code && !['ENOENT', 'ERR_BUFFER_TOO_LARGE'].includes(error.code)) throw error; return false; }
    }
}
