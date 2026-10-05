import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { findGlideLandingGround, glideCoverClear, glideTerrainBands, type GlideScreening } from './glide-analysis.ts';
import { FT, GLIDE_RULES, type Bounds, type GlideCorridor, type GlideGrid, type GlideLandingArea } from './glide-model.ts';
import type { GlideSurface } from './glide-raster.ts';
import { gdalCommand } from './gdal.ts';
import { removeSmallGlideHoles, simplifyGlideOutline } from './glide-display.ts';

type Polygon = { type: 'Polygon'; coordinates: number[][][] };
const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function metricProjector(grid: GlideGrid) {
    const [lon, lat] = grid.coordinate(0, 0), [east, south] = grid.coordinate(1, 1);
    return ([x, y]: number[]) => [grid.west + (x - lon) / (east - lon) * grid.cell,
        grid.north - (y - lat) / (south - lat) * grid.cell];
}

function witnessPolygon(q: GlideCorridor, metric: ReturnType<typeof metricProjector>): Polygon {
    const a = metric([q[0] / 1e6, q[1] / 1e6]), b = metric([q[2] / 1e6, q[3] / 1e6]);
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]), dx = (b[0] - a[0]) / length, dy = (b[1] - a[1]) / length;
    const r = q[4] * FT / 2 * GLIDE_RULES.metricMargin, end = GLIDE_RULES.endClearanceFt * FT * GLIDE_RULES.metricMargin;
    const ring = [[-end, r], [length + end, r], [length + end, -r], [-end, -r], [-end, r]]
        .map(([along, across]) => [a[0] + along * dx - across * dy, a[1] + along * dy + across * dx]);
    return { type: 'Polygon', coordinates: [ring] };
}

/** Closed GeoJSON rings; the delivery encoding leaves the duplicate closing vertex implicit. */
export function glideAreaPolygon(area: GlideLandingArea): Polygon {
    return { type: 'Polygon', coordinates: area[1].map(ring => {
        const points: number[][] = [];
        let x = 0, y = 0;
        for (let i = 0; i < ring.length; i += 2) {
            x += ring[i]; y += ring[i + 1]; points.push([x / 1e6, y / 1e6]);
        }
        points.push(points[0]);
        return points;
    }) };
}

function encodePolygon(witness: GlideCorridor, polygon: Polygon, flags: number): GlideLandingArea {
    if (polygon.type !== 'Polygon' || !polygon.coordinates.length) throw new Error('Expected connected glide Polygon');
    const rings = polygon.coordinates.map(points => {
        const ring: number[] = [];
        let x = 0, y = 0;
        for (const point of points.slice(0, -1)) {
            const nx = Math.round(point[0] * 1e6), ny = Math.round(point[1] * 1e6);
            if (!Number.isSafeInteger(nx) || !Number.isSafeInteger(ny)) throw new Error('Invalid glide polygon vertex');
            if (ring.length && nx === x && ny === y) continue;
            ring.push(nx - x, ny - y); x = nx; y = ny;
        }
        if (ring.length < 6) throw new Error('Glide polygon collapsed during quantization');
        return ring;
    });
    return [witness, rings, flags];
}

export function glideAreaBounds(areas: GlideLandingArea[]): Bounds {
    const bounds: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
    for (const area of areas) for (const ring of glideAreaPolygon(area).coordinates) for (const [x, y] of ring) {
        bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y);
        bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], y);
    }
    return bounds;
}

async function readPolygons(file: string, witness: (properties: any) => GlideCorridor, flags: (properties: any) => number): Promise<GlideLandingArea[]> {
    const areas: GlideLandingArea[] = [];
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
        if (!line.trim()) continue;
        const feature = JSON.parse(line);
        areas.push(encodePolygon(witness(feature.properties), feature.geometry, flags(feature.properties)));
    }
    return areas;
}

/** Test the stored coordinates, after projection and E6 rounding. Metric-space
 * validity alone does not survive rounding at almost coincident boundaries. */
async function invalidQuantizedAreas(areas: GlideLandingArea[], grid: GlideGrid, directory: string): Promise<number[]> {
    if (!areas.length) return [];
    const metric = metricProjector(grid), origin = metric([0, 0]), unit = metric([1, 1]);
    const geographic = ([x, y]: number[]) => [(x - origin[0]) / (unit[0] - origin[0]), (y - origin[1]) / (unit[1] - origin[1])];
    const input = path.join(directory, 'quantized.geojson'), output = path.join(directory, 'invalid-quantized.geojson');
    await fs.writeFile(input, JSON.stringify({ type: 'FeatureCollection', features: areas.flatMap((area, areaIndex) => [
        { type: 'Feature', properties: { areaIndex, kind: 0 }, geometry: glideAreaPolygon(area) },
        { type: 'Feature', properties: { areaIndex, kind: 1 }, geometry: { type: 'Polygon',
            coordinates: witnessPolygon(area[0], metric).coordinates.map(ring => ring.map(geographic)) } }
    ]) }));
    await fs.rm(output, { force: true });
    await gdalCommand('ogr2ogr', ['-f', 'GeoJSON', '-dialect', 'SQLite', '-sql',
        'SELECT a.areaIndex FROM quantized a JOIN quantized w ON a.areaIndex=w.areaIndex AND w.kind=1 ' +
        'WHERE a.kind=0 AND (ST_IsValid(a.geometry) IS NOT 1 OR ST_IsEmpty(a.geometry) IS NOT 0 ' +
        'OR ST_Covers(a.geometry,w.geometry) IS NOT 1)', output, input]);
    return JSON.parse(await fs.readFile(output, 'utf8')).features.map(feature => feature.properties.areaIndex);
}

/** A failed display optimization keeps the original screened outline. Check
 * that fallback too, rather than silently emitting invalid analysis again. */
export async function selectQuantizedGlideAreas(candidates: GlideLandingArea[], originals: GlideLandingArea[],
    grid: GlideGrid, directory: string): Promise<GlideLandingArea[]> {
    if (candidates.length !== originals.length) throw new Error('Glide geometry selection lost a qualified area');
    const invalid = await invalidQuantizedAreas(candidates, grid, directory);
    if (!invalid.length) return candidates;
    const fallback = invalid.map(index => originals[index]);
    if ((await invalidQuantizedAreas(fallback, grid, directory)).length) {
        throw new Error('Original glide outline is invalid or loses its full fit after quantization');
    }
    const result = candidates.slice();
    for (const index of invalid) result[index] = originals[index];
    return result;
}

/** Polygonize screened cells, never an outline inferred from a selected landing direction. */
export async function findAdaptiveGlideLandingAreas(surface: GlideSurface, grid: GlideGrid, directory: string,
    stats?: GlideScreening): Promise<GlideLandingArea[]> {
    const { width, height } = grid, retained = new Uint8Array(surface.cover.length);
    const result: GlideLandingArea[] = [];
    let longestUsableFt = 0;
    const terrainBand = surface.terrainBand ?? glideTerrainBands(surface, width, height, glideCoverClear(surface, width, height));
    // Two complete masks. Quality never becomes an obstacle: broader fits may
    // use preferred ground, and green is drawn above overlapping purple areas.
    const preferredCover = surface.cover.slice();
    const preferredHazards = surface.hazards.slice();
    // Report the broad candidate mask consistently, including when hazards
    // eliminate every fallback cell and only the preferred search runs.
    // Per-pass counters below must not replace this acquisition diagnostic.
    const summary = stats ? { cells: surface.cover.length, known: 0, cover: 0, coverMargin: 0,
        hazardFree: 0, terrain: 0, width: 0, longestUsableFt: 0, skipped: undefined } : undefined;
    for (let i = 0; i < preferredCover.length; i++) {
        if (surface.shrubBand?.[i] || surface.urban?.[i] || surface.mixedOpen?.[i] || surface.canopyUncertain?.[i] || surface.coverUncertain?.[i]) preferredCover[i] = 0;
        if (surface.buildingFallback?.[i] || surface.clearanceFallback?.[i] || surface.obstacleUncertain?.[i]) preferredHazards[i] = 1;
        if (summary) {
            const covered = Boolean(surface.known[i] && surface.cover[i]);
            summary.known += Number(Boolean(surface.known[i]));
            summary.cover += Number(covered);
            summary.hazardFree += Number(covered && !surface.hazards[i]);
            summary.terrain += Number(covered && !surface.hazards[i] && terrainBand[i] > 0);
        }
    }
    const hasFallback = surface.cover.some((value, i) => value && terrainBand[i] && !surface.hazards[i]);
    for (const preferred of hasFallback ? [true, false] : [true]) {
        const cover = preferred ? preferredCover : surface.cover;
        const hazards = preferred ? preferredHazards : surface.hazards;
        const passStats = summary ? { ...summary } : undefined;
        const screenedGround = glideCoverClear({ ...surface, cover }, width, height);
        for (let i = 0; i < screenedGround.length; i++) {
            screenedGround[i] &= Number(!hazards[i] && terrainBand[i] > 0 && (!preferred || terrainBand[i] === 1));
        }
        const selected = { ...surface, cover, hazards, terrainBand, screenedGround,
            fitWidthFt: preferred ? GLIDE_RULES.widthFt : GLIDE_RULES.fallbackWidthFt,
            minimumLengthFt: preferred ? GLIDE_RULES.tiers[1].minimumLengthFt : GLIDE_RULES.tiers[0].minimumLengthFt,
            targetLengthFt: preferred ? GLIDE_RULES.tiers[1].minimumLengthFt : GLIDE_RULES.fallbackTargetLengthFt,
            alternativeWidthFt: preferred ? undefined : GLIDE_RULES.fallbackMinimumWidthFt,
            coverClearanceM: preferred ? GLIDE_RULES.coverBoundaryClearanceM : 0 };
        const ground = findGlideLandingGround(selected, grid, passStats, preferred ? undefined : retained);
        longestUsableFt = Math.max(longestUsableFt, passStats?.longestUsableFt ?? 0);
        const areas = await polygonizeGlideLandingGround(selected, grid, directory, ground);
        result.push(...areas);
        const accepted = new Set(areas.map(area => JSON.stringify(area[0])));
        const labels = new Set([...ground.qualifications].filter(([, witness]) => accepted.has(JSON.stringify(witness))).map(([label]) => label));
        for (let i = 0; i < retained.length; i++) if (labels.has(ground.labels[i])) retained[i] = 1;
    }
    if (stats && summary) Object.assign(stats, summary, { coverMargin: summary.cover,
        width: retained.reduce((sum, value) => sum + value, 0), longestUsableFt });
    return result;
}

export async function findGlideLandingAreas(surface: GlideSurface, grid: GlideGrid, directory: string,
    stats?: GlideScreening): Promise<GlideLandingArea[]> {
    return polygonizeGlideLandingGround(surface, grid, directory, findGlideLandingGround(surface, grid, stats));
}

async function polygonizeGlideLandingGround(surface: GlideSurface, grid: GlideGrid, directory: string,
    { labels, qualifications, flags }: ReturnType<typeof findGlideLandingGround>): Promise<GlideLandingArea[]> {
    if (!qualifications.size) return [];
    const work = await fs.mkdtemp(path.join(directory, 'areas-'));
    try {
        const bytes = Buffer.allocUnsafe(labels.length * 4);
        for (let i = 0; i < labels.length; i++) bytes.writeUInt32LE(labels[i], i * 4);
        await fs.writeFile(path.join(work, 'labels.bin'), bytes);
        const vrt = path.join(work, 'labels.vrt'), polygons = path.join(work, 'ground.gpkg');
        await fs.writeFile(vrt, `<VRTDataset rasterXSize="${grid.width}" rasterYSize="${grid.height}">` +
            `<SRS>${xml(grid.srs)}</SRS><GeoTransform>${[grid.west, grid.cell, 0, grid.north, 0, -grid.cell].join(',')}</GeoTransform>` +
            '<VRTRasterBand dataType="UInt32" band="1" subClass="VRTRawRasterBand"><NoDataValue>0</NoDataValue>' +
            `<SourceFilename relativeToVRT="1">labels.bin</SourceFilename><ImageOffset>0</ImageOffset><PixelOffset>4</PixelOffset>` +
            `<LineOffset>${grid.width * 4}</LineOffset><ByteOrder>LSB</ByteOrder></VRTRasterBand></VRTDataset>`);
        await gdalCommand('gdal', ['raster', 'polygonize', '-f', 'GPKG', '-l', 'ground',
            '--attribute-name', 'label', '--lco', 'GEOMETRY_NAME=geom', vrt, polygons]);
        // One segment per quadrant is sufficient at this sub-cell distance;
        // rounded corners would add dozens of meaningless sub-metre vertices.
        const inset = `ST_Buffer(geom, -${GLIDE_RULES.areaInsetM}, 1)`;
        const simplified = path.join(work, 'simplified.gpkg');
        // Preserve the inward offset until the witness is available. Reduction
        // must fall back to this geometry if it would sever a valid fit.
        await gdalCommand('ogr2ogr', ['-f', 'GPKG', '-nln', 'areas', '-lco', 'GEOMETRY_NAME=geom',
            '-dialect', 'SQLite', '-sql', `SELECT label, ${inset} AS geom FROM ground`,
            '-explodecollections', '-nlt', 'POLYGON', simplified, polygons]);
        const witnesses = path.join(work, 'witnesses.geojson');
        // Recheck the whole witness rectangle and both end reserves after reduction.
        // A severed side lobe cannot inherit the parent's qualification.
        const metric = metricProjector(grid);
        await fs.writeFile(witnesses, JSON.stringify({ type: 'FeatureCollection', features: [...qualifications].map(([label, q]) =>
            ({ type: 'Feature', properties: { label }, geometry: witnessPolygon(q, metric) })) }));
        await gdalCommand('ogr2ogr', ['-update', '-nln', 'witnesses', '-a_srs', grid.srs, simplified, witnesses]);
        const sequence = path.join(work, 'areas.geojsonl');
        // Reduce raster stair steps before exporting the geometry to JavaScript.
        // Clipping cannot add ground; failed topology, area or full-fit checks
        // keep the post-inset input. Materialize the expensive candidate once.
        const query = 'WITH candidates AS MATERIALIZED (SELECT a.label,a.geom,w.geom AS witness,ST_Area(a.geom) AS area,' +
            `ST_Intersection(a.geom,ST_SimplifyPreserveTopology(a.geom,${GLIDE_RULES.areaSimplificationM})) AS candidate ` +
            'FROM areas a JOIN witnesses w ON a.label=w.label WHERE ST_Covers(a.geom,w.geom)) ' +
            "SELECT label,CASE WHEN GeometryType(candidate)='POLYGON' AND ST_IsValid(candidate) " +
            `AND ABS(ST_Area(candidate)-area)<=${GLIDE_RULES.displayMaxAreaChangeFraction}*area ` +
            'AND ST_Covers(candidate,witness) THEN candidate ELSE geom END AS geom FROM candidates';
        await gdalCommand('ogr2ogr', ['-f', 'GeoJSONSeq', '-t_srs', 'EPSG:4326', '-lco', 'RS=NO', '-lco', 'COORDINATE_PRECISION=6',
            '-dialect', 'SQLite', '-sql', query, sequence, simplified]);
        let areas = await readPolygons(sequence, p => qualifications.get(p.label)!, p => flags.get(p.label)!);
        const invalid = await invalidQuantizedAreas(areas, grid, work);
        if (invalid.length) {
            // The clipped simplification can create sub-microdegree slivers.
            // Re-export the pre-simplification, inset raster outline while it
            // is still available; never discard a large lobe to fix rounding.
            const fallbackFile = path.join(work, 'originals.geojsonl');
            await gdalCommand('ogr2ogr', ['-f', 'GeoJSONSeq', '-t_srs', 'EPSG:4326', '-lco', 'RS=NO', '-lco', 'COORDINATE_PRECISION=6',
                '-dialect', 'SQLite', '-sql', 'SELECT a.label,a.geom FROM areas a JOIN witnesses w ON a.label=w.label ' +
                'WHERE ST_Covers(a.geom,w.geom)', fallbackFile, simplified]);
            const originals = await readPolygons(fallbackFile, p => qualifications.get(p.label)!, p => flags.get(p.label)!);
            const byFit = new Map(originals.map(area => [JSON.stringify(area[0]), area]));
            const fallback = invalid.map(index => byFit.get(JSON.stringify(areas[index][0]))!);
            if (fallback.some(area => !area) || (await invalidQuantizedAreas(fallback, grid, work)).length) {
                throw new Error('Inset glide outline is invalid or loses its full fit after quantization');
            }
            for (let i = 0; i < invalid.length; i++) areas[invalid[i]] = fallback[i];
        }
        return await simplifyGlideLandingAreas(areas, grid, surface, work);
    } finally { await fs.rm(work, { recursive: true, force: true }); }
}

/** Display reduction only. Every input already contains a checked full-width fit. */
export async function simplifyGlideLandingAreas(areas: GlideLandingArea[], grid: GlideGrid,
    surface: Pick<GlideSurface, 'hazards' | 'known' | 'cover' | 'terrainBand'>, directory: string): Promise<GlideLandingArea[]> {
    if (!areas.length) return areas;
    const work = await fs.mkdtemp(path.join(directory, 'display-'));
    try {
        const metric = metricProjector(grid);
        const input = path.join(work, 'areas.geojson'), database = path.join(work, 'areas.gpkg');
        const outlines: { type: 'Feature'; properties: { areaIndex: number }; geometry: Polygon }[] = [];
        await fs.writeFile(input, JSON.stringify({ type: 'FeatureCollection', features: areas.map((area, id) => {
            const polygon = glideAreaPolygon(area);
            const geom = removeSmallGlideHoles({ type: 'Polygon', coordinates: polygon.coordinates.map(r => r.map(metric)) }, grid, surface);
            const outline = simplifyGlideOutline(geom, GLIDE_RULES.displaySimplificationM);
            outlines.push({ type: 'Feature', properties: { areaIndex: id }, geometry: outline });
            return { type: 'Feature', properties: { areaIndex: id }, geometry: geom };
        }) }));
        await gdalCommand('ogr2ogr', ['-f', 'GPKG', '-nln', 'areas', '-lco', 'GEOMETRY_NAME=geom',
            '-a_srs', grid.srs, database, input]);
        // Keep candidates as geometry. A complex outline can exceed GDAL's
        // 10-million-character JSON string limit when embedded as a WKT field.
        const outlineFile = path.join(work, 'outlines.geojson');
        await fs.writeFile(outlineFile, JSON.stringify({ type: 'FeatureCollection', features: outlines }));
        await gdalCommand('ogr2ogr', ['-update', '-nln', 'outlines', '-lco', 'GEOMETRY_NAME=geom',
            '-a_srs', grid.srs, database, outlineFile]);
        // Preserve the full original fit, not just its endpoints or midpoint.
        const witnesses = path.join(work, 'witnesses.geojson');
        await fs.writeFile(witnesses, JSON.stringify({ type: 'FeatureCollection', features: areas.map((area, id) =>
            ({ type: 'Feature', properties: { areaIndex: id }, geometry: witnessPolygon(area[0], metric) })) }));
        await gdalCommand('ogr2ogr', ['-update', '-nln', 'witnesses', '-a_srs', grid.srs, database, witnesses]);
        // Materialization prevents SQLite from recomputing each candidate for
        // every predicate. A rejected shortcut keeps the input: generic fallback
        // simplification would bypass the same shape anchors we just protected.
        const query = 'WITH candidates AS MATERIALIZED (SELECT a.areaIndex,a.geom,w.geom AS witness,ST_Area(a.geom) AS area,' +
            'o.geom AS candidate FROM areas a JOIN outlines o ON a.areaIndex=o.areaIndex ' +
            'JOIN witnesses w ON a.areaIndex=w.areaIndex) ' +
            "SELECT areaIndex,CASE WHEN GeometryType(candidate)='POLYGON' AND ST_IsValid(candidate) " +
            'AND ST_NPoints(candidate)<ST_NPoints(geom) ' +
            `AND ABS(ST_Area(candidate)-area)<=${GLIDE_RULES.displayMaxAreaChangeFraction}*area ` +
            'AND ST_Covers(geom,candidate) AND ST_Covers(candidate,witness) THEN candidate ELSE geom END AS geom ' +
            'FROM candidates ORDER BY areaIndex';
        const output = path.join(work, 'areas.geojsonl');
        await gdalCommand('ogr2ogr', ['-f', 'GeoJSONSeq', '-t_srs', 'EPSG:4326', '-lco', 'RS=NO', '-lco', 'COORDINATE_PRECISION=6',
            '-dialect', 'SQLite', '-sql', query, output, database]);
        const result = await readPolygons(output, p => areas[p.areaIndex][0], p => areas[p.areaIndex][2]);
        if (result.length !== areas.length) throw new Error('Glide display reduction lost a qualified area');
        return await selectQuantizedGlideAreas(result, areas, grid, work);
    } finally { await fs.rm(work, { recursive: true, force: true }); }
}

/** Dissolve chunk overlap before publishing; retain a qualification already contained by each result. */
export async function mergeGlideLandingAreas(areas: GlideLandingArea[], directory: string): Promise<GlideLandingArea[]> {
    if (areas.length < 2) return areas;
    // Cross-chunk overlap must not give a shrub patch a neighboring open field's
    // preferred qualification, nor erase which fallback band was needed.
    const groups = new Map<number, GlideLandingArea[]>();
    for (const area of areas) {
        const quality = area[2] & ~1;
        if (!groups.has(quality)) groups.set(quality, []);
        groups.get(quality)!.push(area);
    }
    if (groups.size > 1) {
        const merged: GlideLandingArea[] = [];
        for (const group of groups.values()) merged.push(...await mergeGlideLandingAreas(group, directory));
        return merged.sort((a, b) => a[0][0] - b[0][0] || a[0][1] - b[0][1]);
    }
    const work = await fs.mkdtemp(path.join(directory, 'merge-'));
    try {
        const input = path.join(work, 'patches.geojsonl'), database = path.join(work, 'areas.gpkg');
        await fs.writeFile(input, areas.map(area => JSON.stringify({ type: 'Feature', geometry: glideAreaPolygon(area),
            properties: { witness: JSON.stringify(area[0]), flags: area[2], lengthFt: area[0][5],
                midpoint: `POINT(${(area[0][0] + area[0][2]) / 2e6} ${(area[0][1] + area[0][3]) / 2e6})` } })).join('\n') + '\n');
        await gdalCommand('ogr2ogr', ['-f', 'GPKG', '-nln', 'patches', '-lco', 'GEOMETRY_NAME=geom', database, input]);
        const dissolved = path.join(work, 'dissolved.gpkg');
        await gdalCommand('ogr2ogr', ['-f', 'GPKG', '-nln', 'areas', '-lco', 'GEOMETRY_NAME=geom', '-dialect', 'SQLite',
            '-sql', 'SELECT ST_Union(geom) AS geom FROM patches', '-explodecollections', '-nlt', 'POLYGON', dissolved, database]);
        await gdalCommand('ogr2ogr', ['-update', '-nln', 'areas', database, dissolved]);
        const result = path.join(work, 'merged.geojsonl');
        await gdalCommand('ogr2ogr', ['-f', 'GeoJSONSeq', '-lco', 'RS=NO', '-lco', 'COORDINATE_PRECISION=6', '-dialect', 'SQLite',
            '-sql', 'SELECT geom,witness,flags FROM (SELECT a.geom,p.witness,MAX(p.flags) OVER (PARTITION BY a.fid) AS flags,ROW_NUMBER() OVER (PARTITION BY a.fid ' +
                'ORDER BY p.lengthFt DESC,p.witness) AS rank FROM areas a JOIN patches p ' +
                'ON ST_Covers(a.geom,ST_GeomFromText(p.midpoint,4326))) WHERE rank=1', result, database]);
        // GDAL can preserve a JSON string's subtype as a native GeoJSON array.
        const merged = await readPolygons(result, p => typeof p.witness === 'string' ? JSON.parse(p.witness) : p.witness, p => p.flags);
        if (!merged.length) throw new Error('Glide area merge lost all qualifications');
        return merged.sort((a, b) => a[0][0] - b[0][0] || a[0][1] - b[0][1]);
    } finally { await fs.rm(work, { recursive: true, force: true }); }
}
