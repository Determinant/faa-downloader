import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { glideAreaPolygon, mergeGlideLandingAreas } from './glide-areas.ts';
import { gdalCommand } from './gdal.ts';
import type { Bounds, GlideCorridor, GlideLandingArea } from './glide-model.ts';

type Polygon = { type: 'Polygon'; coordinates: number[][][] };
type RecoverUnion = (originals: GlideLandingArea[], error: unknown, bounds?: Bounds) => Promise<GlideLandingArea[]>;
export const UNQUALIFIED_GLIDE_UNION = 'Glide union produced a component without a qualification';

// Assembly-only equivalent of the reference merge in glide-areas.ts. That file
// is part of the screening fingerprint: keep it unchanged so this optimization
// can reuse completed analysis and merge receipts. Differential tests cover the
// encoder and merge together, including byte-for-byte delivery equivalence.
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

async function readPolygons(file: string, witness: (properties: any) => GlideCorridor, flags: (properties: any) => number,
    recover?: (error: unknown, bounds: Bounds) => Promise<GlideLandingArea[]>): Promise<GlideLandingArea[]> {
    const areas: GlideLandingArea[] = [];
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
        if (!line.trim()) continue;
        const feature = JSON.parse(line);
        try {
            if (feature.properties.witness === null) throw new Error(UNQUALIFIED_GLIDE_UNION);
            areas.push(encodePolygon(witness(feature.properties), feature.geometry, flags(feature.properties)));
        }
        catch (error) {
            if (!recover || !(error instanceof Error) || !['Glide polygon collapsed during quantization', UNQUALIFIED_GLIDE_UNION].includes(error.message)) throw error;
            // Preserve the failed union's full bounds before quantization, so
            // recovery cannot revert unrelated, successfully encoded polygons.
            const bounds: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
            for (const ring of feature.geometry.coordinates) for (const [x, y] of ring) {
                bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y);
                bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], y);
            }
            areas.push(...await recover(error, bounds));
        }
    }
    return areas;
}

/** Dissolve chunk overlap before publishing; retain a qualification already contained by each result. */
export async function mergeGlideLandingAreasIndexed(areas: GlideLandingArea[], directory: string,
    recover?: RecoverUnion): Promise<GlideLandingArea[]> {
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
        for (const group of groups.values()) merged.push(...await mergeGlideLandingAreasIndexed(group, directory, recover));
        return merged.sort((a, b) => a[0][0] - b[0][0] || a[0][1] - b[0][1]);
    }
    const work = await fs.mkdtemp(path.join(directory, 'merge-'));
    try {
        const input = path.join(work, 'patches.geojsonl'), database = path.join(work, 'areas.gpkg');
        await fs.writeFile(input, areas.map(area => JSON.stringify({ type: 'Feature', geometry: glideAreaPolygon(area),
            properties: { witness: JSON.stringify(area[0]), flags: area[2], lengthFt: area[0][5],
                midpointX: (area[0][0] + area[0][2]) / 2e6, midpointY: (area[0][1] + area[0][3]) / 2e6,
                midpoint: `POINT(${(area[0][0] + area[0][2]) / 2e6} ${(area[0][1] + area[0][3]) / 2e6})` } })).join('\n') + '\n');
        await gdalCommand('ogr2ogr', ['-f', 'GPKG', '-nln', 'patches', '-lco', 'GEOMETRY_NAME=geom', database, input]);
        const dissolved = path.join(work, 'dissolved.gpkg');
        await gdalCommand('ogr2ogr', ['-f', 'GPKG', '-nln', 'areas', '-lco', 'GEOMETRY_NAME=geom', '-dialect', 'SQLite',
            '-sql', 'SELECT ST_Union(geom) AS geom FROM patches', '-explodecollections', '-nlt', 'POLYGON', dissolved, database]);
        await gdalCommand('ogr2ogr', ['-update', '-nln', 'areas', database, dissolved]);
        const result = path.join(work, 'merged.geojsonl');
        // GeoPackage's outward-rounded R-tree bounds only shortlist candidates.
        // CROSS JOIN keeps the point -> R-tree -> polygon lookup order; the exact
        // ST_Covers test and window ordering still choose the same qualifications.
        await gdalCommand('ogr2ogr', ['-f', 'GeoJSONSeq', '-lco', 'RS=NO', '-lco', 'COORDINATE_PRECISION=6', '-dialect', 'SQLite',
            '-sql', 'WITH matched AS (SELECT a.fid AS areaId,p.witness,MAX(p.flags) OVER (PARTITION BY a.fid) AS flags,ROW_NUMBER() OVER (PARTITION BY a.fid ' +
                'ORDER BY p.lengthFt DESC,p.witness) AS rank FROM patches p ' +
                'CROSS JOIN rtree_areas_geom r ON r.minx<=p.midpointX AND r.maxx>=p.midpointX ' +
                'AND r.miny<=p.midpointY AND r.maxy>=p.midpointY ' +
                'CROSS JOIN areas a ON a.fid=r.id AND ST_Covers(a.geom,ST_GeomFromText(p.midpoint,4326))) ' +
                'SELECT a.geom,m.witness,m.flags FROM areas a LEFT JOIN matched m ON m.areaId=a.fid AND m.rank=1 ' +
                'WHERE a.geom IS NOT NULL', result, database]);
        // GDAL can preserve a JSON string's subtype as a native GeoJSON array.
        const merged = await readPolygons(result, p => typeof p.witness === 'string' ? JSON.parse(p.witness) : p.witness, p => p.flags,
            recover && ((error, bounds) => recover(areas, error, bounds)));
        // NULL unions have no R-tree entry. Replay the reference path only
        // for an empty match set, preserving its precise errors and fallback behavior.
        if (!merged.length) return await mergeGlideLandingAreas(areas, directory);
        return merged.sort((a, b) => a[0][0] - b[0][0] || a[0][1] - b[0][1]);
    } catch (error) {
        // A NULL union has no usable polygon bounds. Its recovery is still
        // confined to this quality group; completed groups remain intact.
        if (recover) return await recover(areas, error);
        throw error;
    } finally { await fs.rm(work, { recursive: true, force: true }); }
}
