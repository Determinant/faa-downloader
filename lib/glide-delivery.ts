import { createHash } from 'node:crypto';
import type { Bounds } from './offline-regions.ts';

export type Area = [number[], number[][], number];
export type Artifact = { file: string; bytes: number; sha256: string };
export type Coverage = { id: string; bounds: Bounds; [key: string]: unknown };
export type SourceShard = Artifact & { id: string; bounds: Bounds; count: number; rawBytes: number; tiers: [number, number] };
export type SourceManifest = {
    schemaVersion: 8 | 9; builderVersion: number; inputSha256: string; generatedAt: string;
    status: 'experimental-candidates'; geometryMeaning: 'generalized-candidate-area';
    rules: Record<string, unknown>; coverage: Coverage[]; provenance: Artifact; shards: SourceShard[];
    [key: string]: unknown;
};
export const DELIVERY_VERSION = 1;
export const DELIVERY_LIMITS = {
    releaseBytes: 5_000_000_000, archiveBytes: 2 * 1024 * 1024, directoryBytes: 256 * 1024,
    blockBytes: 256 * 1024, blockRawBytes: 1024 * 1024, vertices: 65_536,
    records: 4096, rings: 16_384, pageBytes: 512 * 1024, pageEntries: 512,
    oversizedBlockRawBytes: 8 * 1024 * 1024, oversizedBlockBytes: 1792 * 1024,
    oversizedVertices: 524_288, oversizedRings: 65_536,
} as const;
export const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
export const jsonBytes = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
export const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const integer = (value: unknown, min: number, max: number): value is number =>
    Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
export const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
export function validBounds(value: unknown): value is Bounds {
    return Array.isArray(value) && value.length === 4 && value.every(Number.isFinite) &&
        value[0] >= -180 && value[2] <= 180 && value[1] >= -85.05112878 && value[3] <= 85.05112878 &&
        value[0] < value[2] && value[1] < value[3];
}
export function artifact(value: unknown): boolean {
    return object(value) && typeof value.file === 'string' && /^[a-zA-Z0-9_./-]+$/.test(value.file) &&
        !value.file.startsWith('/') && !value.file.split('/').some(p => !p || p === '.' || p === '..') &&
        digest(value.sha256) && integer(value.bytes, 1, DELIVERY_LIMITS.releaseBytes - 1);
}
export function unionBounds(values: readonly Bounds[]): Bounds {
    if (!values.length) throw new Error('Cannot bound an empty collection');
    return values.reduce((b, a) => [Math.min(b[0], a[0]), Math.min(b[1], a[1]),
        Math.max(b[2], a[2]), Math.max(b[3], a[3])] as Bounds, [...values[0]] as Bounds);
}
export const intersects = (a: Bounds, b: Bounds) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
export const contains = (a: Bounds, b: Bounds) => b[0] >= a[0] - 1e-6 && b[1] >= a[1] - 1e-6 && b[2] <= a[2] + 1e-6 && b[3] <= a[3] + 1e-6;
export type AreaInfo = { bounds: Bounds; vertices: number; rings: number };
export function inspectArea(value: unknown, schema: 8 | 9): AreaInfo {
    if (!Array.isArray(value) || value.length !== 3) throw new Error('Invalid glide record');
    const [q, rings, flags] = value;
    if (!Array.isArray(q) || q.length !== (schema === 9 ? 10 : 8) || !q.every(Number.isSafeInteger) ||
        Math.abs(q[0]) > 180e6 || Math.abs(q[2]) > 180e6 || Math.abs(q[1]) > 85e6 || Math.abs(q[3]) > 85e6 ||
        q[4] <= 0 || q[5] <= 0 || ![1, 2].includes(q[7]) || !integer(flags, 0, schema === 9 ? 2047 : 1023) ||
        !Array.isArray(rings) || !rings.length) throw new Error('Invalid glide qualification/rings/flags');
    const bounds: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
    let vertices = 0;
    for (const ring of rings) {
        if (!Array.isArray(ring) || ring.length < 6 || ring.length % 2) throw new Error('Invalid glide ring');
        let x = 0, y = 0;
        for (let i = 0; i < ring.length; i += 2) {
            if (!Number.isSafeInteger(ring[i]) || !Number.isSafeInteger(ring[i + 1])) throw new Error('Invalid coordinate delta');
            x += ring[i]; y += ring[i + 1];
            if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || Math.abs(x) > 180e6 || Math.abs(y) > 85e6) throw new Error('Invalid polygon coordinate');
            bounds[0] = Math.min(bounds[0], x / 1e6); bounds[1] = Math.min(bounds[1], y / 1e6);
            bounds[2] = Math.max(bounds[2], x / 1e6); bounds[3] = Math.max(bounds[3], y / 1e6); vertices++;
        }
    }
    if (!validBounds(bounds)) throw new Error('Degenerate glide bounds');
    return { bounds, vertices, rings: rings.length };
}
export function validateSource(value: unknown): asserts value is SourceManifest {
    if (!object(value) || ![8, 9].includes(value.schemaVersion) || !integer(value.builderVersion, 1, 100_000) ||
        !digest(value.inputSha256) || typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt)) ||
        value.status !== 'experimental-candidates' || value.geometryMeaning !== 'generalized-candidate-area' || !object(value.rules) ||
        !artifact(value.provenance) || !Array.isArray(value.coverage) || !value.coverage.length || value.coverage.length > 10_000 ||
        !Array.isArray(value.shards) || value.shards.length > 10_000) throw new Error('Expected a supported schema-8/9 glide publication');
    const ids = new Set<string>(), files = new Set<string>(), coverage = new Set<string>();
    for (const region of value.coverage) {
        if (!object(region) || typeof region.id !== 'string' || !region.id || coverage.has(region.id) || !validBounds(region.bounds)) throw new Error('Invalid source coverage');
        coverage.add(region.id);
    }
    for (const s of value.shards) {
        const validArtifact = artifact(s);
        if (!validArtifact || !object(s) || typeof s.id !== 'string' || !s.id || ids.has(s.id) || files.has(s.file) ||
            s.file !== `${s.sha256}.glide.gz` || !validBounds(s.bounds) || !integer(s.bytes, 1, 2 * 1024 * 1024) ||
            !integer(s.rawBytes, 1, 16 * 1024 * 1024) || !integer(s.count, 1, 100_000) ||
            !Array.isArray(s.tiers) || s.tiers.length !== 2 || !s.tiers.every(n => integer(n, 0, s.count)) ||
            s.tiers[0] + s.tiers[1] !== s.count) throw new Error('Invalid source shard');
        ids.add(s.id); files.add(s.file);
    }
}

export type Block = {
    key: string; kind: 'detail' | 'overview'; bounds: Bounds; rawBytes: number; bytes: number; sha256: string;
    records: number; vertices: number; rings: number; tiers: [number, number]; schema: 8 | 9 | 0;
    tile: [number, number, number];
    oversized?: true;
};
export type StoredBlock = Block & { file: string };
export type ArchiveEntry = Block & { offset: number };
export type Archive = Artifact & { kind: Block['kind']; bounds: Bounds; blocks: ArchiveEntry[] };
export type Page = Artifact & { bounds: Bounds; entries: number; kind: Block['kind'] };
export type RegionReference = Artifact & { id: string; bounds: Bounds[]; coverage: 'available' | 'partial' | 'unavailable'; downloadBytes: number };
export type DeliveryManifest = {
    product: 'glide-packages'; schemaVersion: 1; generatedAt: string; inputSha256: string; packagingSha256: string;
    source: Record<string, unknown>; provenance: Artifact; coverage: Artifact; indexes: Page[]; regions: RegionReference[];
    overview: { projection: 'EPSG:3857'; tileSize: 256; samplesPerAxis: 4; minZoom: 0; maxZoom: number;
        encoding: 'uint8-preferred-best-effort-prepared'; densityMeaning: 'sampled-ground-area-fraction'; version: 1 };
    limits: typeof DELIVERY_LIMITS; totalBytes: number; records: number; detailDigest: string;
};
