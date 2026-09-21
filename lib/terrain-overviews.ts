import { gunzipSync } from 'node:zlib';
import { TERRAIN_NODATA } from './terrain-grid.ts';

/** Reduce a 512×512 archive to one 256×256 parent tile, preserving maxima and NoData. */
export function reduceTerrainArchive(bytes: Buffer, sampling: 'max' | 'average' = 'max'): Buffer {
    if (bytes.length < 56 || bytes.subarray(0, 8).toString() !== 'ZDEM0002' || bytes.readUInt32LE(20) !== 4) {
        throw new Error('Invalid terrain archive for overview');
    }
    const result = Buffer.alloc(256 * 256 * 2);
    let expectedOffset = 56;
    for (let quadrant = 0; quadrant < 4; quadrant++) {
        const offset = bytes.readUInt32LE(24 + quadrant * 8), length = bytes.readUInt32LE(28 + quadrant * 8);
        if (offset !== expectedOffset || !length || offset + length > bytes.length) throw new Error('Invalid terrain overview payload');
        const grid = gunzipSync(bytes.subarray(offset, offset + length), { maxOutputLength: 256 * 256 * 2 });
        if (grid.length !== 256 * 256 * 2) throw new Error('Invalid terrain overview grid');
        expectedOffset += length;
        const left = (quadrant % 2) * 128, top = Math.floor(quadrant / 2) * 128;
        for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
            const source = ((y * 2) * 256 + x * 2) * 2;
            const a = grid.readInt16LE(source), b = grid.readInt16LE(source + 2),
                c = grid.readInt16LE(source + 512), d = grid.readInt16LE(source + 514);
            // Keep existing maximum overviews byte-for-byte compatible. A surface
            // cannot interpolate through missing children or invent a low edge.
            const height = sampling === 'max' ? Math.max(a, b, c, d)
                : Math.min(a, b, c, d) === TERRAIN_NODATA ? TERRAIN_NODATA : Math.round((a + b + c + d) / 4);
            result.writeInt16LE(height, ((top + y) * 256 + left + x) * 2);
        }
    }
    if (expectedOffset !== bytes.length) throw new Error('Trailing terrain overview payload');
    return result;
}

export function missingTerrainGrid(): Buffer {
    const grid = Buffer.alloc(256 * 256 * 2);
    for (let i = 0; i < grid.length; i += 2) grid.writeInt16LE(TERRAIN_NODATA, i);
    return grid;
}
