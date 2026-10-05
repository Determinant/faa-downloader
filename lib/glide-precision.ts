import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { glideAreaPolygon } from './glide-areas.ts';
import { gdalCommand } from './gdal.ts';
import { FT, GLIDE_RULES, type GlideCorridor, type GlideLandingArea } from './glide-model.ts';

type Polygon = ReturnType<typeof glideAreaPolygon>;

// Work in integer microdegrees, so the final containment checks use the exact
// delivered vertices, without another geographic rounding operation.
function qualification(q: GlideCorridor): Polygon | undefined {
    const north = 6371008.8 * Math.PI / 180 / 1e6;
    const east = north * Math.cos((q[1] + q[3]) / 2e6 * Math.PI / 180);
    const dx = (q[2] - q[0]) * east, dy = (q[3] - q[1]) * north, length = Math.hypot(dx, dy);
    if (!Number.isFinite(length) || length <= 0 || q[4] <= 0) return;
    // The original analysis uses a 1% dimensional allowance. Half of it here
    // covers the small change from the chunk's latitude to the fit's latitude.
    const radius = q[4] * FT / 2 * 1.005, end = GLIDE_RULES.endClearanceFt * FT * GLIDE_RULES.metricMargin;
    const points = [[-end, radius], [length + end, radius], [length + end, -radius], [-end, -radius], [-end, radius]];
    return { type: 'Polygon', coordinates: [points.map(([along, across]) =>
        [q[0] + (along * dx - across * dy) / length / east,
            q[1] + (along * dy + across * dx) / length / north])] };
}

function encode(area: GlideLandingArea, polygon: Polygon): GlideLandingArea | undefined {
    if (polygon.type !== 'Polygon' || !polygon.coordinates.length) return;
    const rings: number[][] = [];
    for (const points of polygon.coordinates) {
        let x = 0, y = 0;
        const ring: number[] = [];
        for (const [nx, ny] of points.slice(0, -1)) {
            if (!Number.isSafeInteger(nx) || !Number.isSafeInteger(ny)) return;
            if (ring.length && nx === x && ny === y) continue;
            ring.push(nx - x, ny - y); x = nx; y = ny;
        }
        if (ring.length < 6) return;
        rings.push(ring);
    }
    return [area[0], rings, area[2]];
}

/** Recover rounding defects conservatively, never by buffering outward or
 * filling a hole. Ring roles define the reference: polygonal shell minus every
 * exclusion, even if a broken hole lies outside the shell. Only a connected
 * result containing the entire existing fit can be retained. */
export async function recoverGlidePrecision(area: GlideLandingArea): Promise<{
    area: GlideLandingArea; removedFraction: number;
} | undefined> {
    const witness = qualification(area[0]);
    if (!witness) return;
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-precision-'));
    try {
        const database = path.join(work, 'rings.gpkg'), input = path.join(work, 'rings.geojson');
        const features = glideAreaPolygon(area).coordinates.map((ring, index) => ({ type: 'Feature',
            properties: { hole: Number(index > 0) }, geometry: { type: 'Polygon',
                coordinates: [ring.map(point => point.map(value => Math.round(value * 1e6)))] } }));
        await fs.writeFile(input, JSON.stringify({ type: 'FeatureCollection', features }));
        // This is a synthetic planar coordinate system, never exported as a map.
        await gdalCommand('ogr2ogr', ['-f', 'GPKG', '-a_srs', 'EPSG:3857', '-nln', 'rings', '-lco', 'GEOMETRY_NAME=geom', database, input]);
        const reference = path.join(work, 'reference.gpkg');
        await gdalCommand('ogr2ogr', ['-f', 'GPKG', '-nln', 'reference', '-lco', 'GEOMETRY_NAME=geom', '-dialect', 'SQLite', '-sql',
            'WITH shell AS (SELECT ST_CollectionExtract(ST_MakeValid(geom),3) AS geom FROM rings WHERE hole=0), ' +
            'holes AS (SELECT ST_Union(ST_MakeValid(geom)) AS geom FROM rings WHERE hole=1) ' +
            'SELECT CASE WHEN h.geom IS NULL THEN s.geom ELSE ST_Difference(s.geom,h.geom) END AS geom FROM shell s,holes h', reference, database]);
        await gdalCommand('ogr2ogr', ['-update', '-nln', 'reference', database, reference]);
        const fitFile = path.join(work, 'witness.geojson');
        await fs.writeFile(fitFile, JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: witness }] }));
        await gdalCommand('ogr2ogr', ['-update', '-a_srs', 'EPSG:3857', '-nln', 'witness', '-lco', 'GEOMETRY_NAME=geom', database, fitFile]);
        for (const inset of [0, 1, 2]) {
            const candidatesFile = path.join(work, `candidates-${inset}.geojson`);
            // An inward grid-unit margin exceeds the maximum vertex rounding
            // displacement (sqrt(0.5²+0.5²)). The explicit final predicates below
            // are still required: validity and containment cannot be assumed.
            await gdalCommand('ogr2ogr', ['-f', 'GeoJSON', '-nln', 'candidates', '-lco', 'COORDINATE_PRECISION=0',
                '-dialect', 'SQLite', '-sql',
                'WITH holes AS (SELECT ST_Union(ST_MakeValid(geom)) AS geom FROM rings WHERE hole=1) ' +
                (inset === 0 ? 'SELECT r.geom FROM reference r' :
                `SELECT CASE WHEN h.geom IS NULL THEN ST_Buffer(r.geom,-${inset}) ` +
                `ELSE ST_Difference(ST_Buffer(r.geom,-${inset}),ST_Buffer(h.geom,${inset})) END AS geom FROM reference r,holes h`),
                '-explodecollections', candidatesFile, database]);
            const candidateText = (await fs.readFile(candidatesFile, 'utf8')).trim();
            const features = candidateText ? JSON.parse(candidateText).features : [];
            const candidates: GlideLandingArea[] = [];
            for (const feature of features) {
                if (!feature.geometry) continue;
                const candidate = encode(area, feature.geometry);
                if (candidate) candidates.push(candidate);
            }
            if (!candidates.length) continue;
            // Reconstruct from the actual wire encoding before testing it.
            await fs.writeFile(candidatesFile, JSON.stringify({ type: 'FeatureCollection', features: candidates.map((record, index) =>
                ({ type: 'Feature', properties: { candidate: index }, geometry: { type: 'Polygon',
                    coordinates: glideAreaPolygon(record).coordinates.map(ring => ring.map(point => point.map(value => Math.round(value * 1e6)))) } })) }));
            const layer = `candidates${inset}`;
            await gdalCommand('ogr2ogr', ['-update', '-a_srs', 'EPSG:3857', '-nln', layer, '-lco', 'GEOMETRY_NAME=geom', database, candidatesFile]);
            const accepted = path.join(work, `accepted-${inset}.geojson`);
            await gdalCommand('ogr2ogr', ['-f', 'GeoJSON', '-dialect', 'SQLite', '-sql',
                'WITH holes AS (SELECT ST_Union(ST_MakeValid(geom)) AS geom FROM rings WHERE hole=1) ' +
                `SELECT c.candidate,1-ST_Area(c.geom)/ST_Area(r.geom) AS removed FROM ${layer} c,reference r,witness w,holes h ` +
                "WHERE GeometryType(c.geom)='POLYGON' AND ST_IsValid(c.geom)=1 AND ST_IsEmpty(c.geom)=0 " +
                'AND ST_IsValid(r.geom)=1 AND ST_Area(r.geom)>0 AND ST_Covers(r.geom,c.geom)=1 AND ST_Covers(c.geom,w.geom)=1 ' +
                "AND (h.geom IS NULL OR ST_Relate(c.geom,h.geom,'F********')=1)", accepted, database]);
            // SQLite may expose no fields for a zero-row computed result; GDAL
            // then creates an empty file instead of an empty FeatureCollection.
            const acceptedText = (await fs.readFile(accepted, 'utf8')).trim();
            const results = acceptedText ? JSON.parse(acceptedText).features : [];
            if (results.length === 1) {
                const { candidate, removed } = results[0].properties;
                if (Number.isInteger(candidate) && candidates[candidate] && Number.isFinite(removed) &&
                    removed >= 0 && removed < 1) {
                    return { area: candidates[candidate], removedFraction: removed };
                }
            }
        }
    } finally { await fs.rm(work, { recursive: true, force: true }); }
}
