import { intersects, type TerrainBounds } from './terrain-raster.ts';

export type Bounds = TerrainBounds;
export const RASTER_ROLES = ['elevation', 'landcover', 'canopy', 'impervious'] as const;
export const SHRUB_ROLES = ['shrubCover', 'shrubHeight'] as const;
export const OPTIONAL_RASTER_ROLES = [...SHRUB_ROLES, 'shrubTreeCover', 'fineLandcover'] as const;
export const ALL_RASTER_ROLES = [...RASTER_ROLES, ...OPTIONAL_RASTER_ROLES] as const;
export const VECTOR_ROLES = ['buildings', 'powerlines', 'obstacles', 'water', 'roads'] as const;
export const OPTIONAL_VECTOR_ROLES = ['ground'] as const;
export type RasterRole = typeof ALL_RASTER_ROLES[number];
export type VectorRole = typeof VECTOR_ROLES[number];
export type SourceRole = RasterRole | VectorRole | typeof OPTIONAL_VECTOR_ROLES[number];

// These are screening thresholds, not aircraft landing-performance figures.
// Stable pre-release builder version. Rules, explicit analysis revision and source identities
// invalidate derived caches independently; the wire schema is versioned separately.
export const GLIDE_VERSION = 1;
export const GLIDE_RULES = {
    cellM: 10,
    maxElevationPixelM: 12,
    maxCoverPixelM: 40,
    widthFt: 200,
    fallbackWidthFt: 100,
    fallbackMinimumWidthFt: 60,
    fallbackTargetLengthFt: 1500,
    // Length tiers describe the actual screened fit. Mapped hazards have their
    // own setbacks; adding 2,000 ft here hid otherwise useful emergency options.
    endClearanceFt: 0,
    tiers: [{ id: 1, name: 'best-effort', minimumLengthFt: 600 },
        { id: 2, name: 'preferred', minimumLengthFt: 2000 }],
    allowedLandcover: [71, 81, 82],
    urbanOpenLandcover: 21,
    bareLandcover: 31, // Sand/bare substrate remains unverified, purple only.
    shrubLandcover: 52,
    // Development screening bands, not measured landing-success probabilities.
    // Native-pixel modeled mean height is NOT a maximum individual shrub height.
    // Nested bands retain source uncertainty in the best-effort component flags.
    // The final band is purple best effort only, never preferred landing ground.
    shrubBands: [{ maxCoverPercent: 10, maxMeanHeightCm: 30 },
        { maxCoverPercent: 20, maxMeanHeightCm: 50 },
        { maxCoverPercent: 60, maxMeanHeightCm: 100 }],
    // Generic cultivated land remains eligible regardless of crop type.
    // Tree screening must use canopy data that does not mask agriculture to zero.
    cultivatedLandcover: 82,
    coverBoundaryClearanceM: 10,
    // Allow low modeled estimates seen on open fields in the reviewed samples.
    // Preferred ground retains this limit. Mapped open evidence can qualify
    // the bounded purple allowance below; model agreement is not proof of no trees.
    maxCanopyPercent: 5,
    // A broader model estimate requires independent mapped open ground and
    // exclusion of mapped forest. It never qualifies preferred ground.
    mappedOpenMaxCanopyPercent: 20,
    maxImperviousPercent: 0,
    maxFallbackImperviousPercent: 5,
    mappedOpenMaxImperviousPercent: 50,
    maxGrade: 0.02,
    maxCellReliefM: 0.5,
    maxNeighborhoodReliefM: 2,
    // Purple ranks broad landforms, not runway smoothness. These are mapping
    // bounds, NOT stopping distances or certified aircraft performance limits.
    // Native extrema and abrupt breaks remain exclusions in every band.
    fallbackTerrain: [{ maxGrade: 0.06, maxResidualM: 0.75, maxCellResidualM: 1 },
        { maxGrade: 0.12, maxResidualM: 1.5, maxCellResidualM: 1.5 }],
    buildingClearanceM: 30,
    fallbackBuildingClearanceM: 20,
    groundBarrierClearanceM: 60,
    fallbackGroundBarrierClearanceM: 10,
    powerlineClearanceM: 60,
    waterClearanceM: 30,
    fallbackWaterClearanceM: 5,
    roadClearanceM: 30,
    pathClearanceM: 10,
    obstacleClearanceM: 100,
    fallbackObstacleClearanceM: 30,
    possibleGuyWireClearanceM: 610,
    craneClearanceM: 150,
    // Preparation allowance for mapped geometry, not a source accuracy claim.
    mappedPositionAllowanceM: 30,
    unknownHorizontalAccuracyM: 1852,
    // FAA tethered balloons can exceed 14,000 ft AGL: their full height-based
    // clearance plus position uncertainty needs more than the old 4 km limit.
    maxHazardBufferM: 10000,
    analysisHaloM: 1600,
    inventoryHaloM: 12000,
    headingStepDegrees: 10,
    maxUsableLengthM: 2000,
    metricMargin: 1.01,
    areaInsetM: 1,
    // Presentation only, after the original ground and full fit are checked.
    areaSimplificationM: 10,
    displaySimplificationM: 15,
    displayShortcutMaxSpanM: 80,
    displayAnchorReachM: 80,
    displayAnchorTurnDegrees: 30,
    displayMaxAreaChangeFraction: 0.02,
    displayHoleMaxAreaM2: 2500,
    displayHoleMaxSpanM: 80,
    displayHoleMaxFilledFraction: 0.02,
} as const;
export const FT = 0.3048;
const DEG = Math.PI / 180, EARTH_M = 6371008.8;

export type SourceAsset = {
    name: string; date: string; attribution: string;
    file?: string; url?: string; sha256?: string; bytes?: number;
    revision?: string;
    /** Selects the missing-position-accuracy policy for obstacle features only. */
    obstacleSource?: 'mapped' | 'faa-dof';
    /** Untyped legacy building assets retain the larger ground-barrier setback. */
    buildingSource?: 'footprint' | 'ground-barrier';
    /** Retain transport classes; untyped inventories keep the road clearance. */
    roadSource?: 'typed';
    /** Numeric classes: 1 open grass, 2 beach/bare, 3 excluded ground (forest/wetland/water/industrial). */
    groundSource?: 'mapped';
};
export type GlideRegion = {
    id: string;
    /** Centers are owned by this rectangle; sources must cover coverageBounds. */
    bounds: Bounds;
    coverageBounds: Bounds;
    sources: Record<Exclude<SourceRole, typeof OPTIONAL_RASTER_ROLES[number] | typeof OPTIONAL_VECTOR_ROLES[number]>, SourceAsset[]> &
        Partial<Record<typeof OPTIONAL_RASTER_ROLES[number] | typeof OPTIONAL_VECTOR_ROLES[number], SourceAsset[]>>;
};
export type GlideInventory = { schemaVersion: 1; regions: GlideRegion[] };
export type ResolvedAsset = SourceAsset & { file: string; sha256: string; bytes: number };
export type ResolvedRegion = Omit<GlideRegion, 'sources'> & {
    sources: Record<Exclude<SourceRole, typeof OPTIONAL_RASTER_ROLES[number] | typeof OPTIONAL_VECTOR_ROLES[number]>, ResolvedAsset[]> &
        Partial<Record<typeof OPTIONAL_RASTER_ROLES[number] | typeof OPTIONAL_VECTOR_ROLES[number], ResolvedAsset[]>>;
    /** Automatic acquisition defers these expensive inputs until terrain can fit a landing. */
    loadHazards?: () => Promise<Record<VectorRole, ResolvedAsset[]>>;
    /** Optimistic cover prechecks already performed by automatic acquisition. */
    possibleCoverChunks?: string[];
};
/** Rejection needs only these acquired inputs; missing families cannot approve a candidate. */
export type CoverRejectedRegion = Pick<ResolvedRegion, 'id' | 'bounds' | 'coverageBounds'> & {
    screenedOut: 'cover' | 'surface'; sources: Partial<Record<SourceRole, ResolvedAsset[]>>;
};
export type GlideSourceRegion = ResolvedRegion | CoverRejectedRegion;
export type GlideChunk = { id: string; bounds: Bounds; shard: string };

/** Internal qualification witness: integer endpoints (1e-6 degrees), feet, metres MSL, tier. */
export type GlideCorridor = [lon1E6: number, lat1E6: number, lon2E6: number, lat2E6: number,
    widthFt: number, usableLengthFt: number, maximumElevationM: number, tier: number,
    alongGradePermille?: number, crossGradePermille?: number];

/** A screened qualification and generalized display Polygon; not a per-cell clearance map. */
export type GlideLandingArea = [qualification: GlideCorridor, boundaryRingsDeltaE6: number[][],
    flags: number]; // bits: 0 crop, 1 shrub, 2 broader shrub, 3 canopy disagreement, 4 slope, 5 urban open, 6 building setback, 7 bare/mixed open surface, 8 constrained fit/clearance, 9 reduced obstacle exclusion

export function expandBounds(bounds: Bounds, metres: number): Bounds {
    const dy = metres / (EARTH_M * DEG);
    const dx = dy / Math.cos((Math.max(Math.abs(bounds[1]), Math.abs(bounds[3])) + dy) * DEG);
    return [bounds[0] - dx, bounds[1] - dy, bounds[2] + dx, bounds[3] + dy];
}

export function containsBounds(outer: Bounds, inner: Bounds): boolean {
    return outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
}

export function inside(bounds: Bounds, lon: number, lat: number): boolean {
    return lon >= bounds[0] && lon < bounds[2] && lat >= bounds[1] && lat < bounds[3];
}

function validBounds(value: unknown): value is Bounds {
    return Array.isArray(value) && value.length === 4 && value.every(Number.isFinite) &&
        value[0] >= -180 && value[2] <= 180 && value[1] >= -80 && value[3] <= 80 &&
        value[0] < value[2] && value[1] < value[3];
}

export function validateGlideInventory(value: any): GlideInventory {
    if (value?.schemaVersion !== 1 || !Array.isArray(value.regions) || !value.regions.length) {
        throw new Error('Glide sources require schemaVersion: 1 and nonempty regions');
    }
    const ids = new Set<string>();
    for (const region of value.regions) {
        if (!region || typeof region.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(region.id) || ids.has(region.id) ||
            !validBounds(region.bounds) || !validBounds(region.coverageBounds) ||
            !containsBounds(region.coverageBounds, expandBounds(region.bounds, GLIDE_RULES.inventoryHaloM))) {
            throw new Error(`Each glide region needs a unique id and source coverage extending at least ${GLIDE_RULES.inventoryHaloM / 1000} km beyond its bounds`);
        }
        ids.add(region.id);
        if (Boolean(region.sources?.shrubCover) !== Boolean(region.sources?.shrubHeight)) {
            throw new Error(`${region.id}: shrub cover and height must be supplied together`);
        }
        if (region.sources?.shrubTreeCover && !region.sources?.shrubCover) {
            throw new Error(`${region.id}: shrub tree cover requires paired shrub cover and height`);
        }
        for (const role of [...ALL_RASTER_ROLES, ...VECTOR_ROLES, ...OPTIONAL_VECTOR_ROLES]) {
            const assets = region.sources?.[role];
            if ([...OPTIONAL_RASTER_ROLES, ...OPTIONAL_VECTOR_ROLES].some(optional => optional === role) && assets === undefined) continue;
            if (!Array.isArray(assets) || !assets.length) throw new Error(`${region.id}: missing ${role} coverage`);
            for (const asset of assets) {
                if (!asset || typeof asset.name !== 'string' || !asset.name.trim() ||
                    typeof asset.attribution !== 'string' || !asset.attribution.trim() ||
                    typeof asset.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(asset.date) ||
                    !Number.isFinite(Date.parse(asset.date)) || new Date(asset.date).toISOString().slice(0, 10) !== asset.date ||
                    Boolean(asset.file) === Boolean(asset.url)) throw new Error(`${region.id}: invalid ${role} source`);
                if (asset.obstacleSource !== undefined && (role !== 'obstacles' ||
                    !['mapped', 'faa-dof'].includes(asset.obstacleSource))) {
                    throw new Error(`${region.id}: invalid obstacle source policy`);
                }
                if (asset.buildingSource !== undefined && (role !== 'buildings' ||
                    !['footprint', 'ground-barrier'].includes(asset.buildingSource))) {
                    throw new Error(`${region.id}: invalid building source policy`);
                }
                if (asset.roadSource !== undefined && (role !== 'roads' || asset.roadSource !== 'typed')) {
                    throw new Error(`${region.id}: invalid road source policy`);
                }
                if (asset.groundSource !== undefined && (role !== 'ground' || asset.groundSource !== 'mapped')) {
                    throw new Error(`${region.id}: invalid mapped ground policy`);
                }
                if (asset.file !== undefined && (typeof asset.file !== 'string' || !asset.file.trim())) {
                    throw new Error(`${region.id}: invalid local source path`);
                }
                if (asset.url !== undefined) {
                    const url = new URL(asset.url);
                    if (url.protocol !== 'https:' || url.username || url.password ||
                        !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0) {
                        throw new Error(`${region.id}: HTTPS sources require a pinned SHA-256 and byte count`);
                    }
                } else if ((asset.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(asset.sha256)) ||
                    (asset.bytes !== undefined && (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0))) {
                    throw new Error(`${region.id}: invalid local source identity`);
                }
            }
        }
    }
    for (let i = 0; i < value.regions.length; i++) for (let j = 0; j < i; j++) {
        if (intersects(value.regions[i].bounds, value.regions[j].bounds)) {
            throw new Error('Glide region ownership bounds must not overlap (source coverage may overlap)');
        }
    }
    return value;
}

export function glideChunkCount(region: Pick<GlideRegion, 'bounds'>): number {
    const [w, s, e, n] = region.bounds;
    return (Math.ceil(e * 8) - Math.floor(w * 8)) * (Math.ceil(n * 8) - Math.floor(s * 8));
}

export function* glideChunks(region: GlideRegion): Generator<GlideChunk> {
    const [w, s, e, n] = region.bounds;
    for (let y = Math.floor(s * 8); y < Math.ceil(n * 8); y++) {
        for (let x = Math.floor(w * 8); x < Math.ceil(e * 8); x++) {
            yield { id: `${region.id}-${x}-${y}`, shard: `${Math.floor(x / 8)}-${Math.floor(y / 8)}`,
                bounds: [Math.max(w, x / 8), Math.max(s, y / 8), Math.min(e, (x + 1) / 8), Math.min(n, (y + 1) / 8)] };
        }
    }
}

/** A small local equidistant grid; the 1% dimensional margin exceeds scale variation within a chunk. */
export function glideGrid(bounds: Bounds) {
    const lon0 = (bounds[0] + bounds[2]) / 2, lat0 = (bounds[1] + bounds[3]) / 2;
    const xScale = EARTH_M * DEG * Math.cos(lat0 * DEG), yScale = EARTH_M * DEG;
    const cell = GLIDE_RULES.cellM, halo = GLIDE_RULES.analysisHaloM;
    const west = Math.floor(((bounds[0] - lon0) * xScale - halo) / cell) * cell;
    const north = Math.ceil((bounds[3] * yScale + halo) / cell) * cell;
    const width = Math.ceil(((bounds[2] - lon0) * xScale + halo - west) / cell);
    const height = Math.ceil((north - bounds[1] * yScale + halo) / cell);
    if (width * height > 4_000_000) throw new Error('Glide analysis chunk exceeds memory bound');
    return { width, height, cell, west, north, bounds,
        srs: `+proj=eqc +lat_ts=${lat0} +lon_0=${lon0} +R=${EARTH_M} +units=m +no_defs`,
        extent: [west, north - height * cell, west + width * cell, north],
        coordinate: (x: number, y: number): [number, number] => [lon0 + (west + x * cell) / xScale, (north - y * cell) / yScale] };
}
export type GlideGrid = ReturnType<typeof glideGrid>;

export function lengthTier(lengthFt: number): number {
    return lengthFt >= GLIDE_RULES.tiers[1].minimumLengthFt ? 2 :
        lengthFt >= GLIDE_RULES.tiers[0].minimumLengthFt ? 1 : 0;
}
