import { gzipSync, gunzipSync } from 'node:zlib';
import { artifact, contains, DELIVERY_LIMITS as L, digest, hash, inspectArea, integer, jsonBytes, object, unionBounds,
    validBounds, type ArchiveEntry, type Area, type Block } from './glide-delivery.ts';

const MAGIC = 'GLIDEP01', PREFIX = 16;
export type DetailPayload = { source: string; indices: number[]; areas: Area[] };
export function encodeDetail(payload: DetailPayload): Buffer { return jsonBytes(payload); }
export function validateBlock(value: unknown): asserts value is Block {
    const large = object(value) && value.oversized === true;
    if (!object(value) || typeof value.key !== 'string' || !value.key || value.key.length > 200 ||
        !['detail', 'overview'].includes(value.kind) || !validBounds(value.bounds) || !digest(value.sha256) ||
        (value.oversized !== undefined && value.oversized !== true) ||
        large && (value.kind !== 'detail' || value.records !== 1) ||
        !integer(value.bytes, 1, large ? L.oversizedBlockBytes : L.blockBytes) || !integer(value.rawBytes, 1, large ? L.oversizedBlockRawBytes : L.blockRawBytes) ||
        !Array.isArray(value.tile) || value.tile.length !== 3 || !integer(value.tile[0], 0, 16) ||
        !value.tile.slice(1).every(n => integer(n, 0, 2 ** value.tile[0] - 1)) ||
        !integer(value.records, 0, L.records) || !integer(value.vertices, 0, large ? L.oversizedVertices : L.vertices) || !integer(value.rings, 0, large ? L.oversizedRings : L.rings) ||
        !Array.isArray(value.tiers) || value.tiers.length !== 2 || !value.tiers.every(n => integer(n, 0, value.records)) ||
        value.tiers[0] + value.tiers[1] !== value.records ||
        (value.kind === 'detail' ? ![8, 9].includes(value.schema) || !value.records || !value.vertices || !value.rings
            : value.schema !== 0 || value.records !== 0 || value.vertices !== 0 || value.rings !== 0 || value.rawBytes !== 256 * 256 * 3)) {
        throw new Error('Invalid glide archive block');
    }
}
export function inflateBlock(data: Uint8Array, block: Block): Buffer {
    validateBlock(block);
    if (data.byteLength !== block.bytes || hash(data) !== block.sha256) throw new Error('Glide block compressed identity mismatch');
    const raw = gunzipSync(data, { maxOutputLength: block.rawBytes });
    if (raw.length !== block.rawBytes) throw new Error('Glide block raw length mismatch');
    return raw;
}
export function decodeDetail(data: Uint8Array, block: Block): DetailPayload {
    if (block.kind !== 'detail' || block.schema === 0) throw new Error('Expected glide detail block');
    const value = JSON.parse(inflateBlock(data, block).toString());
    if (!object(value) || !digest(value.source) || !Array.isArray(value.indices) || !Array.isArray(value.areas) ||
        value.areas.length !== block.records || value.indices.length !== block.records ||
        !value.indices.every(n => integer(n, 0, 100_000 - 1)) || new Set(value.indices).size !== value.indices.length) throw new Error('Invalid glide detail payload');
    let vertices = 0, rings = 0;
    const tiers = [0, 0];
    for (const area of value.areas) {
        const info = inspectArea(area, block.schema);
        if (!contains(block.bounds, info.bounds)) throw new Error('Glide block bounds omit geometry');
        vertices += info.vertices; rings += info.rings; tiers[area[0][7] - 1]++;
    }
    if (vertices !== block.vertices || rings !== block.rings || tiers.some((n, i) => n !== block.tiers[i])) throw new Error('Glide block complexity mismatch');
    return value as DetailPayload;
}
export function encodeArchive(parts: { block: Block; data: Buffer }[]): { data: Buffer; entries: ArchiveEntry[] } {
    if (!parts.length || parts.length > L.pageEntries) throw new Error('Invalid glide archive entry count');
    let offset = 0;
    const directory = parts.map(({ block, data }) => {
        validateBlock(block);
        if (block.kind !== parts[0].block.kind || data.length !== block.bytes || hash(data) !== block.sha256) throw new Error('Glide archive payload mismatch');
        const entry = { ...block, offset }; offset += data.length; return entry;
    });
    const encoded = jsonBytes(directory);
    if (encoded.length > L.directoryBytes) throw new Error('Glide archive directory exceeds limit');
    const header = Buffer.alloc(PREFIX); header.write(MAGIC); header.writeUInt32LE(encoded.length, 8);
    const data = Buffer.concat([header, encoded, ...parts.map(p => p.data)]);
    if (data.length > L.archiveBytes) throw new Error('Glide archive exceeds limit');
    return { data, entries: directory.map(e => ({ ...e, offset: PREFIX + encoded.length + e.offset })) };
}
/** Parse only the prefix/directory. Offset reads never require inflating neighbors. */
export function readArchiveDirectory(data: Uint8Array, totalBytes = data.byteLength): ArchiveEntry[] {
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (bytes.length < PREFIX || bytes.toString('ascii', 0, 8) !== MAGIC || bytes.readUInt32LE(12) !== 0 ||
        !integer(totalBytes, PREFIX + 1, L.archiveBytes)) throw new Error('Invalid glide archive header');
    const length = bytes.readUInt32LE(8), start = PREFIX + length;
    if (!length || length > L.directoryBytes || start > bytes.length || start >= totalBytes) throw new Error('Invalid glide archive directory length');
    const entries = JSON.parse(bytes.toString('utf8', PREFIX, start));
    if (!Array.isArray(entries) || !entries.length || entries.length > L.pageEntries) throw new Error('Invalid glide archive directory');
    let offset = 0;
    const keys = new Set<string>();
    for (const entry of entries) {
        validateBlock(entry);
        if ((entry as ArchiveEntry).offset !== offset || keys.has(entry.key) || entry.kind !== entries[0].kind) throw new Error('Invalid glide archive offset/key');
        keys.add(entry.key); offset += entry.bytes;
        if (start + offset > totalBytes) throw new Error('Glide archive payload outside file');
    }
    if (start + offset !== totalBytes) throw new Error('Glide archive trailing or missing bytes');
    return entries.map(e => ({ ...e, offset: e.offset + start }));
}
export const compressBlock = (data: Uint8Array) => gzipSync(data, { level: 9 });
