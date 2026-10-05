import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { endianness } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { gdalCommand } from './gdal.ts';
import { FT, GLIDE_RULES, VECTOR_ROLES, containsBounds, expandBounds, glideGrid, type Bounds, type GlideChunk, type GlideGrid,
    type ResolvedAsset, type ResolvedRegion, type VectorRole } from './glide-model.ts';
import { inspectGlideVectors, type GlideRasterSources } from './glide-sources.ts';
import { glideCoverClear, glideLongComponents, glideTerrainBands, type GlideScreening } from './glide-analysis.ts';

export type GlideSurface = {
    elevationMin: Float32Array; elevationMax: Float32Array;
    /** Conjunction of native-pixel cover masks, reduced by minimum. */
    cover: Uint8Array; cropDependent: Uint8Array;
    /** 0: open fields; 1..N: shrubBands; uncertain canopy separately needs mapped open ground. */
    shrubBand?: Uint8Array;
    urban?: Uint8Array;
    /** Bare ground or a small nonzero impervious fraction: purple only. */
    mixedOpen?: Uint8Array;
    canopyUncertain?: Uint8Array;
    /** Independently corroborated opening despite a categorical cover disagreement. Purple only. */
    coverUncertain?: Uint8Array;
    /** Purple-only cells retained outside preferred physical/position setbacks. */
    clearanceFallback?: Uint8Array;
    obstacleUncertain?: Uint8Array;
    /** Search policy is per pass; never mutate global rules for a narrower fit. */
    fitWidthFt?: number;
    minimumLengthFt?: number;
    targetLengthFt?: number;
    /** Try a narrower witness only if the preferred width misses its target. */
    alternativeWidthFt?: number;
    coverClearanceM?: number;
    /** 0 rejected, 1 strict, 2/3 progressively broader smooth terrain. */
    terrainBand?: Uint8Array;
    /** Cells excluded by the preferred building setback but not purple's. */
    buildingFallback?: Uint8Array;
    known: Uint8Array; hazards: Uint8Array;
    /** Reuse the exact precheck ground after applying hazards; never used to bypass screening. */
    screenedGround?: Uint8Array;
    /** Retained across the acquisition boundary for hazard screening statistics. */
    screenedCover?: Uint8Array;
};

/** Reconcile explicit disagreements; missing required values and mapped wet or
 * blocked ground cannot be upgraded by a positive label elsewhere. */
export function reconcileGlideCover(cover: Uint8Array, masks: {
    land: Uint8Array; canopy: Uint8Array; impervious: Uint8Array;
    mappedRequired: Uint8Array; bare?: Uint8Array; disputed?: Uint8Array;
    ground?: { open: Uint8Array; blocked: Uint8Array };
    fine?: Uint8Array; excluded?: Uint8Array; trees?: Uint8Array; water?: Uint8Array;
    newerOpenEvidence: boolean;
}): Uint8Array {
    const uncertainty = new Uint8Array(cover.length);
    for (let i = 0; i < cover.length; i++) {
        if (!cover[i]) continue;
        const { ground, fine, bare } = masks;
        const mappedGrass = Boolean(ground && (ground.open[i] & 1));
        const open = fine?.[i] === 2 || fine?.[i] === 1 && bare?.[i] ||
            mappedGrass || ground && (ground.open[i] & 2) && bare?.[i];
        const lowModels = masks.canopy[i] === 2 && masks.impervious[i] >= 2;
        const disputed = Boolean(masks.disputed?.[i]);
        const recoveredForest = disputed && lowModels && mappedGrass && fine?.[i] === 2 && !masks.excluded?.[i];
        const recoveredOldTree = masks.newerOpenEvidence && !disputed &&
            (masks.land[i] === 1 || masks.land[i] === 2) && lowModels && mappedGrass &&
            masks.trees?.[i] === 1 && masks.water?.[i] === 0;
        if (ground?.blocked[i] || masks.excluded?.[i] && !recoveredOldTree ||
            disputed && !recoveredForest || masks.mappedRequired[i] && !open) cover[i] = 0;
        else if (recoveredForest || recoveredOldTree) uncertainty[i] = 1;
    }
    return uncertainty;
}

async function readBand(file: string, cells: number, byte: boolean): Promise<Float32Array | Uint8Array> {
    const header = await fs.readFile(file.replace(/\.[^.]+$/, '.hdr'), 'utf8');
    const data = await fs.readFile(file);
    if (data.length !== cells * (byte ? 1 : 4) || !/bands\s*=\s*1\b/.test(header) ||
        !new RegExp(`data type\\s*=\\s*${byte ? 1 : 4}\\b`).test(header) || !/header offset\s*=\s*0\b/.test(header)) {
        throw new Error(`Invalid glide analysis raster: ${file}`);
    }
    if (byte) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const bigEndian = /byte order\s*=\s*1\b/.test(header);
    if (bigEndian !== (endianness() === 'BE')) data.swap32();
    const aligned = data.byteOffset % 4 ? Uint8Array.from(data) : data;
    return new Float32Array(aligned.buffer, aligned.byteOffset, cells);
}

type RasterGrid = Pick<GlideGrid, 'srs' | 'extent' | 'width' | 'height'>;

function geometryArgs(grid: RasterGrid): string[] {
    return ['-t_srs', grid.srs, '-te', ...grid.extent.map(String), '-ts', String(grid.width), String(grid.height)];
}

async function warp(source: string, file: string, grid: RasterGrid, resampling: 'min' | 'max', mask = false) {
    await gdalCommand('gdalwarp', ['-q', '-overwrite', '-of', 'ENVI', '-ot', mask ? 'Byte' : 'Float32',
        '-ovr', 'NONE', '-novshift', '-r', resampling, ...geometryArgs(grid),
        // Zero is an excluded *valid* contributor. GDAL's min reducer can drop
        // values equal to destination NoData, even with -srcnodata None.
        // Reserve 254 (never used by eligibility or 0/255 validity masks).
        ...(mask ? ['-srcnodata', 'None', '-dstnodata', '254'] : ['-dstnodata', 'nan']), source, file]);
    const values = await readBand(file, grid.width * grid.height, mask);
    if (mask) for (let i = 0; i < values.length; i++) if (values[i] === 254) values[i] = 0;
    return values;
}

async function mappedGround(sources: ResolvedAsset[], grid: GlideGrid, directory: string) {
    const cells = grid.width * grid.height, open = new Uint8Array(cells), blocked = new Uint8Array(cells);
    const work = await fs.mkdtemp(path.join(directory, 'mapped-ground-'));
    try {
        for (const [index, source] of sources.entries()) {
            if (source.groundSource !== 'mapped') throw new Error('Mapped ground requires explicit source interpretation');
            const subset = path.join(work, `ground-${index}.gpkg`);
            await gdalCommand('ogr2ogr', ['-f', 'GPKG', '-nln', 'ground', '-lco', 'GEOMETRY_NAME=geom',
                '-t_srs', grid.srs, '-spat_srs', 'EPSG:4326', '-spat', ...expandBounds(grid.bounds, GLIDE_RULES.analysisHaloM + 100).map(String), subset, source.file]);
            for (const excluded of [false, true]) {
                const file = path.join(work, `ground-${index}-${Number(excluded)}.bin`);
                // Whole 10 m cell footprints must fit inside a mapped open
                // polygon. Forest/wetland geometry wins over overlapping open maps.
                const sql = excluded ? 'SELECT ST_Buffer(geom,5) AS geom FROM ground WHERE groundClass=3' :
                    `SELECT ST_Buffer(geom,-${Math.SQRT2 * grid.cell / 2 + .1}) AS geom,groundClass FROM ground WHERE groundClass IN (1,2)`;
                await gdalCommand('gdal_rasterize', ['-q', '-of', 'ENVI', '-ot', 'Byte', '-init', '0',
                    '-dialect', 'SQLite', '-sql', sql, ...(excluded ? ['-burn', '1', '-at'] : ['-a', 'groundClass']), '-a_srs', grid.srs,
                    '-te', ...grid.extent.map(String), '-ts', String(grid.width), String(grid.height), subset, file]);
                const values = await readBand(file, cells, true), target = excluded ? blocked : open;
                for (let i = 0; i < cells; i++) target[i] |= values[i];
            }
        }
        return { open, blocked };
    } finally { await fs.rm(work, { recursive: true, force: true }); }
}

/** Optimistic regional rejection only. Every retained chunk still uses the original 10 m analysis. */
export async function possibleGlideChunks(sources: Partial<GlideRasterSources>, chunks: GlideChunk[], directory: string): Promise<Set<string>> {
    const possible = new Set(chunks.map(chunk => chunk.id));
    if (!chunks.length || chunks.length > 4096) return possible;
    // Index whole analysis grids, including their halos, not just ownership bounds.
    const bounds = chunks.map(chunk => {
        const grid = glideGrid(chunk.bounds), [w, n] = grid.coordinate(0, 0), [e, s] = grid.coordinate(grid.width, grid.height);
        return [w, s, e, n] as Bounds;
    });
    const step = 0.002;
    const west = Math.floor(Math.min(...bounds.map(b => b[0])) / step) * step - 2 * step;
    const north = Math.ceil(Math.max(...bounds.map(b => b[3])) / step) * step + 2 * step;
    const width = Math.ceil((Math.max(...bounds.map(b => b[2])) - west) / step) + 2;
    const height = Math.ceil((north - Math.min(...bounds.map(b => b[1]))) / step) + 2;
    // Large custom inventories can fall back to the bounded per-chunk path.
    if (width * height > 4_000_000) return possible;
    const grid: RasterGrid = { srs: 'EPSG:4326', extent: [west, north - height * step, west + width * step, north], width, height };
    const windows = bounds.map(([w, s, e, n]) => [
        Math.max(0, Math.floor((w - west) / step) - 2), Math.max(0, Math.floor((north - n) / step) - 2),
        Math.min(width, Math.ceil((e - west) / step) + 2), Math.min(height, Math.ceil((north - s) / step) + 2),
    ]);
    const retain = (eligible: (i: number) => boolean) => {
        for (const [index, chunk] of chunks.entries()) {
            if (!possible.has(chunk.id)) continue;
            const [x0, y0, x1, y1] = windows[index];
            let found = false;
            for (let y = y0; y < y1 && !found; y++) for (let x = x0; x < x1; x++) {
                if (eligible(y * width + x)) { found = true; break; }
            }
            if (!found) possible.delete(chunk.id);
        }
    };
    const work = await fs.mkdtemp(path.join(directory, 'presence-'));
    try {
        // Any known elevation is sufficient here; minimum validity remains mandatory in detailed analysis.
        if (sources.elevation) {
            const known = await warp(sources.elevation.known, path.join(work, 'known.bin'), grid, 'max', true);
            retain(i => known[i] > 0);
        }
        if (!possible.size) return possible;
        for (const role of ['landcover', 'canopy', 'impervious'] as const) {
            if (!possible.size) break;
            if (!sources[role]) continue;
            if (!sources[role].eligible) throw new Error(`${role}: native eligibility mask missing`);
            const maximum = await warp(sources[role].eligible, path.join(work, `${role}.bin`), grid, 'max', true);
            retain(i => maximum[i] > 0);
        }
        // The criteria need not overlap in the index: separate potential
        // pixels deliberately cause false positives, never acceptance.
        // Two index cells of query padding accommodate source footprints and reprojection edges.
        return possible;
    } finally { await fs.rm(work, { recursive: true, force: true }); }
}

const ORDINARY_OBSTACLES = new Set([
    'BUILDING', 'BLDG', 'BLDG_TWR', 'TREE', 'POLE', 'CHIMNEY', 'STACK', 'POWER_TOWER', 'T_L_TWR',
    'TRANSMISSION_TOWER', 'WATER_TOWER', 'POWER_POLE', 'UTILITY_POLE', 'PYLON', 'CTRL_TWR', 'CONTROL_TOWER',
    'TANK', 'STORAGE_TANK', 'SIGN', 'LIGHTING', 'PARKING', 'FENCE', 'WALL', 'RETAINING_WALL',
    'SOLAR_PANEL', 'SOLAR_PANELS', 'SOLAR_PANEL_ARRAY', 'BRIDGE', 'DAM', 'WEIR', 'WINDMILL',
    'WIND_TURBINE', 'MONUMENT', 'ELEVATOR',
]);

/** Explicit accuracy wins; only identified mapped sources use the smaller fallback. */
export function hazardBuffer(role: VectorRole, properties: any = {}, obstacleSource?: ResolvedAsset['obstacleSource'], fallback = false): number {
    properties ??= {};
    let buffer: number;
    if (role === 'buildings') buffer = GLIDE_RULES.groundBarrierClearanceM;
    else if (role === 'powerlines') buffer = GLIDE_RULES.powerlineClearanceM;
    else if (role === 'water') buffer = GLIDE_RULES.waterClearanceM;
    else if (role === 'roads') buffer = GLIDE_RULES.roadClearanceM;
    else {
        const accuracyFt = [NaN, 20, 50, 100, 250, 500, 1000];
        const code = Number(properties.horizontalAccuracyCode);
        const hasCode = properties.horizontalAccuracyCode != null && String(properties.horizontalAccuracyCode).trim() !== '';
        let uncertainty: number = obstacleSource === 'mapped' ? GLIDE_RULES.mappedPositionAllowanceM : GLIDE_RULES.unknownHorizontalAccuracyM;
        if (hasCode) uncertainty = Number.isInteger(code) && code >= 1 && code <= 6 ? accuracyFt[code] * FT :
            code === 7 ? 926 : GLIDE_RULES.unknownHorizontalAccuracyM;
        if (properties.horizontalAccuracyM != null) uncertainty = Number(properties.horizontalAccuracyM);
        const height = properties.heightAglFt != null ? Number(properties.heightAglFt) * FT :
            properties.heightM != null ? Number(properties.heightM) : 0;
        if (!Number.isFinite(uncertainty) || uncertainty < 0 || !Number.isFinite(height) || height < 0) {
            throw new Error('Invalid obstacle height or horizontal accuracy');
        }
        // Untyped custom sources cannot inherit an identified-source relaxation.
        fallback &&= obstacleSource !== undefined;
        // FAA uses names such as "UTILITY POLE"; mapped sources use snake_case.
        // Normalize separators before applying the same physical class policy.
        const type = String(properties.structureType ?? properties.subtype ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
        // Identified ordinary structures are not generic radio masts. Keep the
        // wide fallback for masts and unknown types, but do not assign possible
        // guy wires to a control-tower building, tank, sign or lighting pole.
        // Reported height and position uncertainty still enlarge every buffer.
        const physical = /CRANE/.test(type) ? GLIDE_RULES.craneClearanceM :
            ORDINARY_OBSTACLES.has(type) ?
                fallback ? GLIDE_RULES.fallbackObstacleClearanceM : GLIDE_RULES.obstacleClearanceM :
                GLIDE_RULES.possibleGuyWireClearanceM;
        buffer = Math.max(physical, height * 1.5) + uncertainty;
    }
    if (!Number.isFinite(buffer) || buffer > GLIDE_RULES.maxHazardBufferM) {
        throw new Error(`Obstacle buffer ${Math.ceil(buffer)} m exceeds the ${GLIDE_RULES.maxHazardBufferM} m source-query limit; ` +
            'expand the buffer limit and inventory halo together before publishing');
    }
    return buffer * GLIDE_RULES.metricMargin;
}

/** Include hazards outside the analysis grid whose buffers can reach into it. */
export function hazardQueryBounds(bounds: Bounds, role: VectorRole): Bounds {
    const buffer = role === 'obstacles' ? GLIDE_RULES.maxHazardBufferM * GLIDE_RULES.metricMargin : hazardBuffer(role);
    return expandBounds(bounds, GLIDE_RULES.analysisHaloM + buffer + 50);
}

/** Only variable-clearance obstacles cross JS, one clipped feature at a time. */
async function writeObstacleBuffers(input: string, output: string, obstacleSource?: ResolvedAsset['obstacleSource']): Promise<number> {
    let count = 0;
    const record = (line: string): string => {
        const feature = JSON.parse(line);
        if (feature.type !== 'Feature' || !feature.geometry) throw new Error('Unlocated obstacle in prepared subset');
        try { feature.properties = { bufferM: hazardBuffer('obstacles', feature.properties, obstacleSource),
            fallbackBufferM: hazardBuffer('obstacles', feature.properties, obstacleSource, true) }; }
        catch (error) {
            const p = feature.properties ?? {};
            throw new Error(`${p.id ?? feature.id ?? p.structureType ?? 'obstacle'} ` +
                `(AGL ${p.heightAglFt ?? '?'} ft, height ${p.heightM ?? '?'} m): ${(error as Error).message}`, { cause: error });
        }
        count++;
        return JSON.stringify(feature) + '\n';
    };
    await pipeline(createReadStream(input), async function* (chunks: AsyncIterable<Buffer>) {
        let pending: Buffer[] = [];
        for await (const chunk of chunks) {
            let start = 0, end: number;
            while ((end = chunk.indexOf(10, start)) !== -1) {
                const part = chunk.subarray(start, end);
                const line = (pending.length ? Buffer.concat([...pending, part]) : part).toString('utf8').trim();
                pending = [];
                if (line) yield record(line);
                start = end + 1;
            }
            if (start < chunk.length) pending.push(chunk.subarray(start));
        }
        const tail = Buffer.concat(pending).toString('utf8').trim();
        if (tail) yield record(tail);
    }, createWriteStream(output));
    return count;
}

async function prepareHazardSubset(source: ResolvedAsset, role: VectorRole, grid: GlideGrid, query: Bounds,
    directory: string): Promise<string | undefined> {
    let input = source.file, filter = ['-spat_srs', 'EPSG:4326', '-spat', ...query.map(String)];
    if (role === 'obstacles') {
        const sequence = path.join(directory, 'obstacles.geojsonl'), annotated = path.join(directory, 'buffers.geojsonl');
        // GeoJSONSeq is WGS84. Clip in that destination CRS before streaming;
        // project into the metric grid only after attaching each clearance.
        await gdalCommand('ogr2ogr', ['-f', 'GeoJSONSeq', '-t_srs', 'EPSG:4326',
            '-lco', 'RS=NO', '-lco', 'COORDINATE_PRECISION=15', ...filter, '-clipdst', ...query.map(String), sequence, input]);
        if (!await writeObstacleBuffers(sequence, annotated, source.obstacleSource)) return;
        input = annotated;
        filter = [];
    }
    const buffer = role === 'obstacles' ? GLIDE_RULES.maxHazardBufferM * GLIDE_RULES.metricMargin : hazardBuffer(role);
    // Keep enough geometry outside the grid for its full buffer to reach in.
    // Clipping at the grid edge itself would lose nearby external hazards.
    const padding = buffer + 2 * grid.cell;
    const extent = grid.extent.map((value, i) => value + (i < 2 ? -padding : padding));
    const subset = path.join(directory, 'subset.gpkg');
    await gdalCommand('ogr2ogr', ['-f', 'GPKG', '-nln', 'hazards', '-nlt', 'GEOMETRY',
        '-lco', 'GEOMETRY_NAME=geom', '-lco', 'SPATIAL_INDEX=NO', '-t_srs', grid.srs,
        ...filter, '-clipdst', ...extent.map(String), ...(role === 'obstacles' ? [] : ['-select', role === 'roads' && source.roadSource === 'typed' ? 'class' : '']), subset, input]);
    return subset;
}

export function buildingBuffers(source: Pick<ResolvedAsset, 'buildingSource'>): [number, number] {
    return source.buildingSource === 'footprint' ?
        [GLIDE_RULES.buildingClearanceM * GLIDE_RULES.metricMargin, GLIDE_RULES.fallbackBuildingClearanceM * GLIDE_RULES.metricMargin] :
        [hazardBuffer('buildings'), source.buildingSource === 'ground-barrier' ?
            GLIDE_RULES.fallbackGroundBarrierClearanceM * GLIDE_RULES.metricMargin : hazardBuffer('buildings')];
}

export async function readGlideHazards(region: ResolvedRegion, grid: GlideGrid, directory: string): Promise<Uint8Array> {
    return (await readGlideHazardMasks(region, grid, directory)).preferred;
}

type HazardPass = { buffer: number | string; where?: string; preferred: boolean; fallback: boolean };

async function hazardPasses(subset: string, buffers: (number | string)[]): Promise<HazardPass[]> {
    const [preferred, fallback = preferred] = buffers;
    if (preferred === fallback) return [{ buffer: preferred, preferred: true, fallback: true }];
    const separate = (where?: string): HazardPass[] => [
        { buffer: preferred, where, preferred: true, fallback: false },
        { buffer: fallback, where, preferred: false, fallback: true },
    ];
    if (typeof preferred === 'number' && typeof fallback === 'number') return separate();
    // Variable columns/road expressions can differ while their per-feature
    // values are equal. Rasterize that common subset once for both masks.
    const equal = `(${preferred})=(${fallback})`;
    const summary = JSON.parse(await gdalCommand('ogr2ogr', ['-f', 'GeoJSON', '-dialect', 'SQLite', '-sql',
        `SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN ${equal} THEN 1 ELSE 0 END),0) AS shared FROM hazards`,
        '/vsistdout/', subset]));
    const { total, shared } = summary.features[0]?.properties ?? {};
    if (!Number.isSafeInteger(total) || !Number.isSafeInteger(shared) || shared < 0 || shared > total) {
        throw new Error('Invalid hazard buffer partition counts');
    }
    if (!total) return [];
    if (!shared) return separate();
    if (shared === total) return [{ buffer: preferred, preferred: true, fallback: true }];
    return [{ buffer: preferred, where: equal, preferred: true, fallback: true },
        ...separate(`NOT (${equal})`)];
}

export async function readGlideHazardMasks(region: ResolvedRegion, grid: GlideGrid, directory: string, terrain?: Uint8Array) {
    const losses: { source: string; cells: number }[] = [];
    const cells = grid.width * grid.height, preferred = new Uint8Array(cells), fallback = new Uint8Array(cells);
    const obstacleFallback = new Uint8Array(cells), buildingFallback = new Uint8Array(cells);
    for (const role of VECTOR_ROLES) for (const source of region.sources[role]) {
        const query = hazardQueryBounds(grid.bounds, role);
        if (!containsBounds(region.coverageBounds, query)) {
            throw new Error(`${region.id}: ${role} query exceeds declared source coverage; expand coverageBounds and reacquire its inputs`);
        }
        const work = await fs.mkdtemp(path.join(directory, 'hazards-'));
        try {
            const subset = await prepareHazardSubset(source, role, grid, query, work);
            if (!subset) continue;
            // Stream the same metric buffers directly into rasterization instead
            // of writing and reopening a second GeoPackage for every source/chunk.
            const buffers = role === 'buildings' ? buildingBuffers(source) : role === 'obstacles' ? ['bufferM', 'fallbackBufferM'] :
                role === 'water' ? [hazardBuffer(role), GLIDE_RULES.fallbackWaterClearanceM * GLIDE_RULES.metricMargin] :
                role === 'roads' && source.roadSource === 'typed' ? [GLIDE_RULES.pathClearanceM * GLIDE_RULES.metricMargin, 0].map(margin =>
                    `CASE WHEN class IN ('footway','path','pedestrian','cycleway','bridleway') THEN ${margin} WHEN class='steps' THEN ${GLIDE_RULES.pathClearanceM * GLIDE_RULES.metricMargin} ELSE ${hazardBuffer(role)} END`) : [hazardBuffer(role)];
            const passes = await hazardPasses(subset, buffers);
            // Common and differing buffers can overlap. Count each source's
            // fallback footprint once, retaining the original loss diagnostic.
            const counted = terrain && passes.filter(pass => pass.fallback).length > 1 ? new Uint8Array(cells) : undefined;
            let removed = 0;
            for (const [index, pass] of passes.entries()) {
                const { buffer, where } = pass;
                const raster = path.join(work, `mask-${index}.bin`);
                // Zero means no extra setback, not removal of the hazard:
                // buffering a line by zero would erase it before rasterization.
                const geometry = `CASE WHEN (${buffer})=0 THEN geom ELSE ST_Buffer(geom, ${buffer}) END`;
                await gdalCommand('gdal_rasterize', ['-q', '-of', 'ENVI', '-ot', 'Byte', '-init', '0',
                    '-dialect', 'SQLite', '-sql', `SELECT ${geometry} AS geom FROM hazards${where ? ` WHERE ${where}` : ''}`,
                    '-burn', '1', '-at', '-a_srs', grid.srs, '-te', ...grid.extent.map(String),
                    '-ts', String(grid.width), String(grid.height), subset, raster]);
                const values = await readBand(raster, cells, true);
                for (let i = 0; i < cells; i++) if (values[i]) {
                    if (pass.preferred) preferred[i] = 1;
                    if (pass.preferred && role === 'obstacles') obstacleFallback[i] = 1;
                    if (pass.preferred && role === 'buildings') buildingFallback[i] = 1;
                    if (pass.fallback) {
                        fallback[i] = 1;
                        if (terrain?.[i] && !counted?.[i]) { removed++; if (counted) counted[i] = 1; }
                    }
                }
            }
            if (removed) losses.push({ source: source.name, cells: removed });
        } catch (error) {
            throw new Error(`${region.id}: ${role} source ${source.name}: ${(error as Error).message}`, { cause: error });
        } finally { await fs.rm(work, { recursive: true, force: true }); }
    }
    for (let i = 0; i < cells; i++) {
        obstacleFallback[i] &= Number(!fallback[i]);
        buildingFallback[i] &= Number(!fallback[i]);
    }
    return { preferred, fallback, obstacleFallback, buildingFallback, losses };
}

export async function readGlideSurface(region: ResolvedRegion, sources: GlideRasterSources,
    grid: GlideGrid, directory: string, options: { screening?: GlideScreening; prepareHazards?: () => Promise<void> } = {}): Promise<GlideSurface | null> {
    const surface = await readGlideGround(sources, grid, directory, options.screening);
    if (!surface) return null;
    await (options.prepareHazards ? options.prepareHazards() : inspectGlideVectors(region));
    return applyGlideHazards(region, surface, grid, directory, options.screening);
}

/** CPU stage one: screening can reject a chunk without acquiring any hazard sources. */
export async function readGlideGround(sources: GlideRasterSources, grid: GlideGrid, directory: string,
    stats?: GlideScreening): Promise<GlideSurface | null> {
    if (stats) Object.assign(stats, { cells: grid.width * grid.height, known: 0, cover: 0, coverMargin: 0,
        hazardFree: 0, terrain: 0, width: 0, longestUsableFt: 0, skipped: 'cover' });
    const cells = grid.width * grid.height;
    const known = await warp(sources.elevation.known, path.join(directory, 'elevation-known.bin'), grid, 'min', true) as Uint8Array;
    if (stats) stats.known = known.reduce((sum, value) => sum + Number(Boolean(value)), 0);
    if (!known.some(Boolean)) return null;
    const combined = new Uint8Array(cells).fill(1);
    const primary = {} as Record<'landcover' | 'canopy' | 'impervious', Uint8Array>;
    const mixedOpen = new Uint8Array(cells);
    const canopyUncertain = new Uint8Array(cells), mappedRequired = new Uint8Array(cells);
    for (const role of ['landcover', 'canopy', 'impervious'] as const) {
        if (!sources[role]?.eligible) throw new Error(`${role}: native eligibility mask missing`);
        const mask = await warp(sources[role].eligible, path.join(directory, `${role}-eligible.bin`), grid, 'min', true);
        primary[role] = mask as Uint8Array;

        for (let i = 0; i < cells; i++) {
            if (!mask[i]) combined[i] = 0;
            if (role === 'canopy' && mask[i] === 1) { canopyUncertain[i] = 1; mappedRequired[i] = 1; }
        }
        if (role === 'impervious') for (let i = 0; i < cells; i++) {
            if (mask[i] === 1 || mask[i] === 2) mixedOpen[i] = 1;
            if (mask[i] === 1) mappedRequired[i] = 1;
        }
        if (!combined.some(Boolean)) return null;
    }
    const urban = sources.landcover.urban ? await warp(sources.landcover.urban,
        path.join(directory, 'urban-maximum.bin'), grid, 'max', true) as Uint8Array : undefined;
    if (sources.landcover.mappedOnly) {
        const mask = await warp(sources.landcover.mappedOnly, path.join(directory, 'mapped-only.bin'), grid, 'max', true);
        for (let i = 0; i < cells; i++) if (mask[i]) { mappedRequired[i] = 1; mixedOpen[i] = 1; }
    }
    const bare = sources.landcover.bare ? await warp(sources.landcover.bare,
        path.join(directory, 'bare-maximum.bin'), grid, 'max', true) : undefined;
    const ground = sources.ground?.length ? await mappedGround(sources.ground, grid, directory) : undefined;
    if (sources.fineLandcover && !sources.fineLandcover.excluded) throw new Error('Fine land cover requires native exclusion flags');
    const fine = sources.fineLandcover ? await warp(sources.fineLandcover.eligible,
        path.join(directory, 'fine-landcover-minimum.bin'), grid, 'min', true) : undefined;
    const fineExcluded = sources.fineLandcover?.excluded ? await warp(sources.fineLandcover.excluded,
        path.join(directory, 'fine-landcover-excluded.bin'), grid, 'max', true) : undefined;
    const fineDate = sources.fineLandcover?.newestDate;
    const newerOpenEvidence = Boolean(fineDate && sources.landcover.oldestDate > fineDate &&
        sources.canopy.oldestDate > fineDate && sources.ground?.length && sources.ground.every(a => a.date > fineDate));
    const evidenceMask = async (file: string | undefined, name: string) => file ?
        await warp(file, path.join(directory, `${name}.bin`), grid, 'max', true) as Uint8Array : undefined;
    const coverUncertain = reconcileGlideCover(combined, { land: primary.landcover, canopy: primary.canopy,
        impervious: primary.impervious, mappedRequired, bare: bare as Uint8Array, ground,
        disputed: await evidenceMask(sources.landcover.disputed, 'coarse-cover-disagreement'),
        fine: fine as Uint8Array, excluded: fineExcluded as Uint8Array, newerOpenEvidence,
        trees: newerOpenEvidence ? await evidenceMask(sources.fineLandcover?.trees, 'old-tree-cover') : undefined,
        water: newerOpenEvidence ? await evidenceMask(sources.fineLandcover?.water, 'fine-water-cover') : undefined });
    for (let i = 0; i < cells; i++) if (bare?.[i]) mixedOpen[i] = 1;
    let shrubBand: Uint8Array | undefined;
    if (sources.landcover.shrub) {
        const shrub = await warp(sources.landcover.shrub, path.join(directory, 'shrub-maximum.bin'), grid, 'max', true);
        if (shrub.some((value, i) => value && combined[i])) {
            shrubBand = new Uint8Array(cells);
            // Missing supplemental data never approves shrubland; ordinary fields
            // keep their existing policy and do not require RCMAP coverage.
            const masks: (Float32Array | Uint8Array)[] = [];
            for (const role of ['shrubCover', 'shrubHeight'] as const) if (sources[role]) {
                masks.push(await warp(sources[role].eligible, path.join(directory, `${role}-eligible.bin`), grid, 'min', true));
            }
            for (let i = 0; i < cells; i++) if (shrub[i]) {
                const level = masks.length === 2 ? Math.min(masks[0][i], masks[1][i]) : 0;
                if (!level) combined[i] = 0;
                shrubBand[i] = level ? GLIDE_RULES.shrubBands.length - level + 1 : 0;
            }
        }
    }
    const coverSurface = { known, cover: combined, cropDependent: new Uint8Array(cells), shrubBand, urban, mixedOpen, canopyUncertain, coverUncertain };
    const values = async (method: 'min' | 'max') =>
        await warp(sources.elevation.values, path.join(directory, `elevation-${method}.bin`), grid, method) as Float32Array;
    const cover = glideCoverClear(coverSurface, grid.width, grid.height, stats);
    // Terrain and hazards can only remove cells. If cover alone cannot fit the
    // required length, neither later stage can recover a corridor. Actual width
    // and cover setbacks are checked later in the oriented footprint.
    if (!glideLongComponents(cover.slice(), grid.width, grid.height)) return null;
    // Sequential GDAL jobs keep peak RAM and disk I/O bounded.
    const surface: GlideSurface = { ...coverSurface, elevationMin: await values('min'),
        elevationMax: await values('max'), hazards: new Uint8Array(known.length) };
    surface.terrainBand = glideTerrainBands(surface, grid.width, grid.height, cover);
    const terrain = Uint8Array.from(surface.terrainBand, value => Number(value > 0));
    if (stats) { stats.skipped = 'terrain'; stats.terrain = terrain.reduce((sum, value) => sum + value, 0); }
    if (!glideLongComponents(terrain.slice(), grid.width, grid.height)) return null;
    // This display flag is only needed for surfaces that survive terrain screening.
    const cropMaximum = await warp(sources.landcover.cultivated ?? sources.landcover.eligible,
        path.join(directory, 'cultivated-maximum.bin'), grid, 'max', true);
    surface.cropDependent = Uint8Array.from(cropMaximum, value => Number(value === (sources.landcover.cultivated ? 1 : 2)));
    surface.screenedGround = terrain;
    surface.screenedCover = cover;
    return surface;
}

/** CPU stage two: resume the exact screened arrays after asynchronous hazard acquisition. */
export async function applyGlideHazards(region: ResolvedRegion, surface: GlideSurface, grid: GlideGrid,
    directory: string, stats?: GlideScreening): Promise<GlideSurface> {
    for (const role of VECTOR_ROLES) if (!region.sources[role]?.length) throw new Error(`${region.id}: ${role} sources were not acquired`);
    const { preferred, fallback, obstacleFallback, buildingFallback, losses } = await readGlideHazardMasks(region, grid, directory, stats ? surface.screenedGround : undefined);
    if (stats) stats.hazardLosses = losses;
    surface.hazards = fallback;
    surface.buildingFallback = buildingFallback;
    surface.clearanceFallback = Uint8Array.from(preferred, (value, i) => Number(value && !fallback[i]));
    surface.obstacleUncertain = obstacleFallback;
    const terrain = surface.screenedGround!, cover = surface.screenedCover!;
    if (stats) { stats.hazardFree = 0; stats.terrain = 0; }
    for (let i = 0; i < terrain.length; i++) {
        if (surface.hazards[i]) terrain[i] = 0;
        if (stats) { stats.hazardFree += Number(Boolean(cover[i] && !surface.hazards[i])); stats.terrain += terrain[i]; }
    }
    delete surface.screenedCover;
    return surface;
}
