import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { glideGrid, type ResolvedRegion } from '../lib/glide-model.ts';
import { GlideChunkWorkers } from '../lib/glide-worker.ts';
import { GdalPool } from '../lib/gdal.ts';
import { terrainCommand } from '../lib/terrain-raster.ts';

test('shared workers queue excess chunks, propagate hazard failures, clean up, and reuse slots without stale sources',
    { timeout: 30_000 }, async t => {
        try { await terrainCommand('gdalwarp', ['--version']); }
        catch { t.skip('Requires GDAL'); return; }
        const gdal = await GdalPool.create(1);
        t.after(() => gdal.close());
        await gdal.run(async () => {
            const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-workers-'));
            const workers = new GlideChunkWorkers(2);
            t.after(async () => { await workers.close(); await fs.rm(directory, { recursive: true, force: true }); });
            const region: ResolvedRegion = { id: 'fixture', bounds: [-98, 25, -97.99, 25.01],
                coverageBounds: [-99, 24, -97, 26], sources: {} as never };
            const grid = glideGrid(region.bounds), cells = grid.width * grid.height;
            const raster = async (name: string, fill: number) => {
                const raw = path.join(directory, `${name}.bin`), vrt = path.join(directory, `${name}.vrt`);
                const data = Buffer.alloc(cells * 4);
                for (let i = 0; i < cells; i++) data.writeFloatLE(fill, i * 4);
                await fs.writeFile(raw, data);
                await fs.writeFile(vrt, `<VRTDataset rasterXSize="${grid.width}" rasterYSize="${grid.height}">
    <SRS>${grid.srs}</SRS><GeoTransform>${grid.west},10,0,${grid.north},0,-10</GeoTransform>
    <VRTRasterBand dataType="Float32" band="1" subClass="VRTRawRasterBand">
    <SourceFilename relativeToVRT="1">${name}.bin</SourceFilename><ImageOffset>0</ImageOffset>
    <PixelOffset>4</PixelOffset><LineOffset>${grid.width * 4}</LineOffset><ByteOrder>LSB</ByteOrder>
    </VRTRasterBand></VRTDataset>`);
                return vrt;
            };
            const zero = await raster('zero', 0), one = await raster('one', 1), strictCanopy = await raster('strict-canopy', 2);
            const sources = { elevation: { known: one, values: zero }, landcover: { eligible: one },
                canopy: { eligible: strictCanopy }, impervious: { eligible: strictCanopy } };
            let requests = 0, release: () => void;
            const bothRequested = new Promise<void>(resolve => { release = resolve; });
            // Neither request can finish until both workers reach the lazy acquisition boundary.
            const hazards = async () => {
                if (++requests === 2) release();
                await bothRequested;
                throw new Error('Fixture hazard acquisition failed');
            };
            const job = (id: string) => ({ region, sources, directory, chunk: { id, bounds: region.bounds, shard: 'fixture' } });
            const results = await Promise.allSettled(['first', 'second', 'third', 'fourth'].map(id => workers.run(job(id), hazards)));
            assert.equal(requests, 4);
            for (const result of results) {
                assert.equal(result.status, 'rejected');
                if (result.status === 'rejected') assert.match(result.reason.message, /Fixture hazard acquisition failed/);
            }
            sources.elevation.known = zero;
            const empty = await workers.run(job('reused'), async () => { throw new Error('Unknown terrain must not acquire hazards'); });
            assert.deepEqual(empty.areas, []);
            assert.equal(empty.screening!.skipped, 'cover');
            // All CPU slots must remain usable when every earlier chunk is waiting
            // for network hazards. An unrelated early rejection should finish first.
            sources.elevation.known = one;
            let bothParked!: () => void, resumeHazards!: () => void;
            const waiting = new Promise<void>(resolve => { bothParked = resolve; });
            const releaseHazards = new Promise<void>(resolve => { resumeHazards = resolve; });
            let parked = 0;
            const blocked = Promise.allSettled(['parked-one', 'parked-two'].map(id => workers.run(job(id), async () => {
                if (++parked === 2) bothParked();
                await releaseHazards;
                throw new Error('Parked fixture released');
            })));
            await waiting;
            sources.elevation.known = zero;
            let timer: NodeJS.Timeout | undefined;
            try {
                const unrelated = await Promise.race([
                    workers.run(job('while-parked'), async () => assert.fail('Unknown terrain must not acquire hazards')),
                    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Hazard waits held CPU slots')), 5000); })
                ]);
                assert.deepEqual(unrelated.areas, []);
            } finally { clearTimeout(timer); resumeHazards(); }
            for (const result of await blocked) assert.equal(result.status, 'rejected');
            assert.deepEqual((await fs.readdir(directory)).sort(), ['one.bin', 'one.vrt', 'strict-canopy.bin', 'strict-canopy.vrt', 'zero.bin', 'zero.vrt']);
        });
    });
