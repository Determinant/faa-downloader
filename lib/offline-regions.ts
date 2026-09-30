export type Bounds = [number, number, number, number];
export type OfflineRegionDefinition = { id: string; title: string; bounds: Bounds[] };

export function validateRegions(regions: readonly OfflineRegionDefinition[]): void {
    if (!Array.isArray(regions)) throw new Error('Offline regions must be an array');
    const ids = new Set<string>();
    for (const region of regions) {
        if (!region || typeof region.id !== 'string' || !region.id.trim() ||
            typeof region.title !== 'string' || !region.title.trim() || ids.has(region.id) || !Array.isArray(region.bounds) ||
            !region.bounds.length || region.bounds.some(bounds => !Array.isArray(bounds) || bounds.length !== 4 ||
                !bounds.every(Number.isFinite) || bounds[0] < -180 || bounds[2] > 180 ||
                bounds[1] < -90 || bounds[3] > 90 || bounds[0] >= bounds[2] || bounds[1] >= bounds[3])) {
            throw new Error(`Invalid offline region: ${region?.id}`);
        }
        ids.add(region.id);
    }
}
