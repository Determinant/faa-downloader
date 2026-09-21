/** Keep geometry synchronized with ZLayer packages/contracts/src/terrain.ts.
 * Geographic cells are anchored at (-180, 90); zoom 10 is exactly 4.9 arc-seconds.
 * Coarser levels double that spacing. Tile and archive edges never shift the grid. */
export const TERRAIN_RESOLUTION_ARC_SECONDS = 4.9;
export const TERRAIN_MAX_ZOOM = 10;
export const TERRAIN_NODATA = -32768;
export const terrainSpacing = (zoom: number) => TERRAIN_RESOLUTION_ARC_SECONDS / 3600 * 2 ** (TERRAIN_MAX_ZOOM - zoom);
export const terrainGridSize = (zoom: number) => ({
    columns: Math.ceil(360 / terrainSpacing(zoom) / 256), rows: Math.ceil(180 / terrainSpacing(zoom) / 256)
});
export type GeographicBounds = readonly [number, number, number, number];

export function terrainRegionBlocks(regions: readonly { bounds: readonly GeographicBounds[] }[], minZoom = 1, maxZoom = TERRAIN_MAX_ZOOM) {
    const blocks = new Map<string, { zoom: number; x: number; y: number }>();
    for (let zoom = minZoom; zoom <= maxZoom; zoom++) {
        const size = terrainGridSize(zoom), span = terrainSpacing(zoom) * 256;
        const col = (lon: number) => Math.max(0, Math.min(size.columns - 1, Math.floor((lon + 180) / span)));
        const row = (lat: number) => Math.max(0, Math.min(size.rows - 1, Math.floor((90 - lat) / span)));
        for (const region of regions) for (const [west, south, east, north] of region.bounds) {
            for (let y = row(north) & ~1; y <= row(south); y += 2) {
                for (let x = col(west) & ~1; x <= col(east); x += 2) blocks.set(`${zoom}/${x}/${y}`, { zoom, x, y });
            }
        }
    }
    return [...blocks.values()].sort((a, b) => a.zoom - b.zoom || a.x - b.x || a.y - b.y);
}

export function terrainGridBounds(zoom: number, x: number, y: number, span = 2, paddingPixels = 0): [number, number, number, number] {
    const step = terrainSpacing(zoom);
    return [Math.max(-180, -180 + (x * 256 - paddingPixels) * step),
        Math.max(-90, 90 - ((y + span) * 256 + paddingPixels) * step),
        Math.min(180, -180 + ((x + span) * 256 + paddingPixels) * step),
        Math.min(90, 90 - (y * 256 - paddingPixels) * step)];
}
