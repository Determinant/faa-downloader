#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GlidePreviewData } from './lib/glide-preview.ts';
import { glideAnalysisIdentity } from './lib/glide-identity.ts';
import { reviewGlideFeatures, type GlideReviewScene } from './lib/glide-review.ts';
import { GdalPool, gdalCommand } from './lib/gdal.ts';

async function main() {
    let output = 'dist';
    for (const arg of process.argv.slice(2)) {
        if (arg.startsWith('--output=') && arg.slice(9).trim()) output = arg.slice(9);
        else throw new Error('Usage: npm run review:glide -- [--output=dist]');
    }
    const scenes: GlideReviewScene[] = JSON.parse(await fs.readFile(new URL('./data/glide-review-scenes.json', import.meta.url), 'utf8'));
    const data = new GlidePreviewData(output), report = [], directory = path.join(output, 'glide-preview', 'review');
    await fs.mkdir(directory, { recursive: true });
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-review-')), pool = await GdalPool.create(1, { tools: ['ogr2ogr'] });
    try { await pool.run(async () => {
        for (const scene of scenes) {
            const view = await data.view(scene.bounds, 12);
            if (view.meta.mode !== 'detail') throw new Error(`Review window too large: ${scene.id}`);
            const file = path.join(directory, `${scene.id}.geojson`);
            await fs.writeFile(file, JSON.stringify({ type: 'FeatureCollection', features: view.features }) + '\n');
            let unionKm2 = 0;
            if (view.features.length) {
                const database = path.join(work, `${scene.id}.gpkg`);
                await gdalCommand('ogr2ogr', ['-f', 'GPKG', '-nln', 'areas', '-lco', 'GEOMETRY_NAME=geom',
                    '-clipsrc', ...scene.bounds.map(String), '-t_srs', 'EPSG:6933', database, file]);
                const stats = JSON.parse(await gdalCommand('ogr2ogr', ['-f', 'GeoJSON', '-dialect', 'SQLite',
                    '-sql', 'SELECT ST_Area(ST_Union(geom))/1000000 AS squareKm FROM areas', '/vsistdout/', database]));
                unionKm2 = stats.features[0]?.properties?.squareKm ?? 0;
            }
            const row = { ...scene, ...reviewGlideFeatures(view.features, scene), unionKm2, checkpoints: view.meta };
            const samples = path.join(output, 'glide-preview', 'samples');
            await fs.mkdir(samples, { recursive: true });
            await fs.writeFile(path.join(samples, `${scene.id}-checkpoint-review.json`), JSON.stringify({
                id: `${scene.id}-checkpoint-review`, title: `${scene.title} · checkpoint review`,
                bounds: scene.bounds, center: [(scene.bounds[1] + scene.bounds[3]) / 2, (scene.bounds[0] + scene.bounds[2]) / 2],
                zoom: 12, generatedAt: new Date().toISOString(), version: view.meta.version, features: view.features,
            }) + '\n');
            report.push(row);
            console.log(`${scene.id}: ${row.preferred} green, ${row.purple} purple patches; ${row.spatialGroupsWithin1Nm} groups within 1 NM; ${unionKm2.toFixed(2)} km² union.`);
        }
    }); } finally { await pool.close(); await fs.rm(work, { recursive: true, force: true }); }
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify({ generatedAt: new Date().toISOString(),
        currentImplementation: await glideAnalysisIdentity(),
        note: 'Reads committed checkpoints, which can predate current screening during rebuild. Counts are not independently usable landing options; review contexts are approximate.',
        scenes: report }, null, 2) + '\n');
    console.log(`Saved ${path.join(directory, 'report.json')} and scene GeoJSONs.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
