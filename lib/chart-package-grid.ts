import type { ChartKind } from './chart-definitions.ts';

export type Bounds = [number, number, number, number];
export type Tile = { z: number; x: number; y: number };
export type ChartPackageArchive = {
    id: string;
    kind: ChartKind;
    file: string;
    zoom: number;
    root: Tile;
    bounds: Bounds;
    tileMask: string;
    byteLength: number;
    sha256: string;
};
export type ChartOfflineRegion = { id: string; title: string; bounds: Bounds[]; archiveIds: string[] };

const MAX_LATITUDE = 85.0511287798066;

export function tileBounds({ z, x, y }: Tile, span = 1): Bounds {
    const n = 2 ** z;
    const latitude = (row: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * row / n))) * 180 / Math.PI;
    return [x / n * 360 - 180, latitude(y + span), (x + span) / n * 360 - 180, latitude(y)];
}

export function tileRange([west, south, east, north]: Bounds, zoom: number): Bounds {
    const n = 2 ** zoom;
    const row = (latitude: number) => {
        const radians = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, latitude)) * Math.PI / 180;
        return (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * n;
    };
    const clamp = (value: number) => Math.max(0, Math.min(n - 1, value));
    return [
        clamp(Math.floor((west + 180) / 360 * n)), clamp(Math.floor(row(north))),
        clamp(Math.ceil((east + 180) / 360 * n) - 1), clamp(Math.ceil(row(south)) - 1)
    ];
}

export function intersects(a: Bounds, b: Bounds): boolean {
    return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

export function packageRoot(tile: Tile): Tile {
    const z = Math.max(0, tile.z - 3);
    const span = 2 ** (tile.z - z);
    return { z, x: Math.floor(tile.x / span), y: Math.floor(tile.y / span) };
}

export function packageId(kind: ChartKind, zoom: number, root: Tile): string {
    return `${kind}-z${zoom}-r${root.z}-${root.x}-${root.y}`;
}

export function regionArchives(bounds: Bounds[], archives: readonly ChartPackageArchive[]): string[] {
    return archives.filter(archive => bounds.some(area => intersects(area, archive.bounds))).map(archive => archive.id);
}
