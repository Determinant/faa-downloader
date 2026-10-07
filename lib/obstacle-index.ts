import fs from 'node:fs/promises';
import type { ObstacleFeature } from './obstacles.ts';

/** ZLayer obstruction index v1: 8-byte header, then 34-byte little-endian records.
 * Keep version, 500 ft floor and symbol ordinal mapping aligned with the contract
 * in docs/obstacles.md. Only the already validated full-source converter calls add. */
export async function createObstacleIndexWriter(destination: string) {
    const file = await fs.open(destination, 'w');
    const buffer = Buffer.alloc(34 * 2048);
    let count = 0, offset = 0;
    try { await file.writeFile(Buffer.alloc(8)); }
    catch (error) { await file.close(); throw error; }
    const flush = async () => { if (offset) await file.writeFile(buffer.subarray(0, offset)); offset = 0; };
    return {
        async add(feature: ObstacleFeature) {
            const p = feature.properties;
            if (p.heightAglFt < 500) return;
            if (offset === buffer.length) await flush();
            const shape = /^WIND(?:MILL| TURBINE)/i.test(p.structureType) ? 2 : p.heightAglFt >= 1000 ? 1 : 0;
            const symbol = shape * 4 + (p.quantity > 1 ? 2 : 0) + (p.lightingCode === 'H' || p.lightingCode === 'S' ? 1 : 0);
            buffer.writeDoubleLE(parseInt(feature.id.replace('-', ''), 36), offset);
            buffer.writeDoubleLE(feature.geometry.coordinates[0], offset + 8);
            buffer.writeDoubleLE(feature.geometry.coordinates[1], offset + 16);
            buffer.writeInt32LE(p.heightAglFt, offset + 24);
            buffer.writeInt32LE(p.elevationMslFt, offset + 28);
            buffer.writeUInt8(symbol, offset + 32);
            buffer.writeUInt8(p.verified ? 1 : 0, offset + 33);
            offset += 34; count++;
        },
        async finish() {
            await flush();
            const header = Buffer.alloc(8);
            header.writeUInt32LE(1, 0); header.writeUInt32LE(count, 4);
            let written = 0;
            while (written < header.length) {
                const result = await file.write(header, written, header.length - written, written);
                if (!result.bytesWritten) throw new Error('Unable to finish obstacle index');
                written += result.bytesWritten;
            }
            return { count, bytes: 8 + 34 * count };
        },
        close: () => file.close()
    };
}
