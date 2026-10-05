import { createHash } from 'node:crypto';
import type { GlideGrid } from '../../lib/glide-model.ts';
import type { GlideSurface } from '../../lib/glide-raster.ts';

const scale = 6371008.8 * Math.PI / 180;

function field(width = 160, height = 120) {
    const cells = width * height;
    const grid: GlideGrid = { width, height, cell: 10, west: 0, north: height * 10,
        bounds: [0, 0, width * 10 / scale, height * 10 / scale], extent: [0, 0, width * 10, height * 10],
        srs: '+proj=eqc +lat_ts=0 +lon_0=0 +R=6371008.8 +units=m +no_defs',
        coordinate: (x, y) => [x * 10 / scale, (height - y) * 10 / scale] };
    const surface: GlideSurface = {
        known: new Uint8Array(cells).fill(1), cover: new Uint8Array(cells).fill(1), hazards: new Uint8Array(cells).fill(1),
        cropDependent: new Uint8Array(cells), screenedGround: new Uint8Array(cells), terrainBand: new Uint8Array(cells),
        elevationMin: Float32Array.from({ length: cells }, (_, i) => 100 + i % width * 0.12 + Math.floor(i / width) * 0.03),
        elevationMax: Float32Array.from({ length: cells }, (_, i) => 100.1 + i % width * 0.12 + Math.floor(i / width) * 0.03),
        fitWidthFt: 100, alternativeWidthFt: 60, minimumLengthFt: 600, targetLengthFt: 1500, coverClearanceM: 0,
    };
    const open = (x0: number, y0: number, x1: number, y1: number, band = 2) => {
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            const i = y * width + x;
            surface.hazards[i] = 0; surface.screenedGround![i] = 1; surface.terrainBand![i] = band;
        }
    };
    return { grid, surface, open };
}

export function* glideSearchCases() {
    for (const width of [3, 5, 8]) {
        const f = field(); f.open(20, 50, 55, 50 + width);
        yield { name: `gentle-short-width-${width}`, ...f };
    }
    for (const angle of [17, 43, 91, 137]) {
        const f = field(), a = angle * Math.PI / 180, dx = Math.cos(a), dy = Math.sin(a);
        for (let y = 1; y < 119; y++) for (let x = 1; x < 159; x++) {
            if ([[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]].every(([xx, yy]) =>
                Math.abs((xx - 80) * dx + (yy - 60) * dy) < 40 && Math.abs(-(xx - 80) * dy + (yy - 60) * dx) < 2.7)) {
                f.open(x, y, x + 1, y + 1);
            }
        }
        yield { name: `oblique-${angle}`, ...f };
    }
    {
        const f = field(); f.open(15, 30, 115, 42); f.open(50, 30, 80, 42, 3);
        yield { name: 'broader-band-needed', ...f };
    }
    {
        const f = field(); f.open(10, 30, 90, 44); f.open(90, 34, 100, 40, 3); f.open(100, 30, 132, 44);
        yield { name: 'recover-detached-gentle-opening', ...f };
    }
    for (const ownership of ['crossing', 'external', 'touching'] as const) {
        const f = field(); f.grid.bounds[0] = 800 / scale;
        f.open(90, 65, 145, 75);
        f.open(10, 30, ownership === 'crossing' ? 140 : ownership === 'touching' ? 80 : 60, 42);
        yield { name: `ownership-${ownership}`, ...f };
    }
    {
        const f = field(); f.open(10, 20, 145, 100);
        for (let y = 20; y < 100; y++) for (let x = 10; x < 145; x++) {
            const i = y * f.grid.width + x;
            if ((x * 37 + y * 71) % 97 < 5) { f.surface.screenedGround![i] = 0; f.surface.hazards[i] = 1; }
            if (x > 80) f.surface.terrainBand![i] = 3;
            if (y > 65) f.surface.cropDependent[i] = 1;
        }
        yield { name: 'fragmented-mixed-masks', ...f };
    }
    {
        const f = field(384, 256); f.open(5, 5, 379, 251); f.open(180, 5, 205, 251, 3);
        // Exceed the cache budget and prevent target-based early termination.
        f.surface.targetLengthFt = 10000;
        yield { name: 'bounded-cache-large-component', ...f };
    }
}

export function searchSnapshot(result: { labels: Uint32Array; qualifications: Map<number, unknown>; flags: Map<number, number> }) {
    const bytes = Buffer.alloc(result.labels.length * 4);
    for (let i = 0; i < result.labels.length; i++) bytes.writeUInt32LE(result.labels[i], i * 4);
    return { labelsSha256: createHash('sha256').update(bytes).digest('hex'),
        qualifications: [...result.qualifications], flags: [...result.flags] };
}
