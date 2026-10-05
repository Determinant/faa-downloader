import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { glideChunks } from '../lib/glide-model.ts';
import { possibleGlideChunks } from '../lib/glide-raster.ts';
import type { GlideRasterSources } from '../lib/glide-sources.ts';

let hasGdal = true;
try { execFileSync('gdalwarp', ['--version'], { stdio: 'ignore' }); }
catch { hasGdal = false; }

test('regional rejection preserves isolated cover pixels, shared edges and halos without averaging',
    { skip: hasGdal ? false : 'Requires the glide builder GDAL tools' }, async t => {
        const work = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-screening-'));
        t.after(() => fs.rm(work, { recursive: true, force: true }));
        // Native 0.00025-degree pixels (under 30 m) around two adjacent chunks.
        const west = -98.05, north = 25.175, step = 0.00025, width = 1400, height = 900;
        const band = async (name: string, fill: number, edits: [number, number, number][] = []) => {
            const file = path.join(work, `${name}.bin`), data = Buffer.alloc(width * height * 4);
            for (let i = 0; i < width * height; i++) data.writeFloatLE(fill, i * 4);
            for (const [lon, lat, value] of edits) {
                const x = Math.floor((lon - west) / step), y = Math.floor((north - lat) / step);
                data.writeFloatLE(value, (y * width + x) * 4);
            }
            await fs.writeFile(file, data);
            await fs.writeFile(path.join(work, `${name}.hdr`), `ENVI\nsamples = ${width}\nlines = ${height}\n` +
                'bands = 1\nheader offset = 0\nfile type = ENVI Standard\ndata type = 4\ninterleave = bsq\nbyte order = 0\n' +
                `map info = {Geographic Lat/Lon, 1, 1, ${west}, ${north}, ${step}, ${step}, WGS-84, units=Degrees}\n`);
            return file;
        };
        const zero = await band('zero', 0), eligible = await band('eligible', 1), known = await band('known', 255);
        const cover = await band('cover', 0, [[-97.875, 25.0625, 1]]);
        const sources: GlideRasterSources = { elevation: { values: zero, known }, landcover: { eligible: cover },
            canopy: { eligible }, impervious: { eligible } };
        const chunks = [...glideChunks({ id: 'fixture', bounds: [-98, 25, -97.75, 25.125],
            coverageBounds: [-99, 24, -97, 26], sources: {} as never })];
        const all = new Set(chunks.map(chunk => chunk.id));
        assert.deepEqual(await possibleGlideChunks(sources, chunks, work), all);
        assert.deepEqual(await possibleGlideChunks({ landcover: sources.landcover }, chunks, work), all,
            'acquisition preflight may reject from one family but cannot require unacquired DEM/hazards');
        // The only eligible pixel is outside ownership but inside the analysis halo.
        sources.landcover.eligible = await band('halo', 0, [[-98.005, 25.0625, 1]]);
        assert.deepEqual(await possibleGlideChunks(sources, chunks, work), new Set([chunks[0].id]));
        sources.elevation.known = zero;
        assert.equal((await possibleGlideChunks(sources, chunks, work)).size, 0);
        sources.elevation.known = known;
        sources.canopy.eligible = zero;
        assert.equal((await possibleGlideChunks(sources, chunks, work)).size, 0);
        sources.canopy.eligible = eligible;
        sources.landcover.eligible = await band('water', 0);
        assert.equal((await possibleGlideChunks(sources, chunks, work)).size, 0);
        assert.equal((await possibleGlideChunks({ landcover: sources.landcover }, [chunks[0]], work)).size, 0,
            'even a single requested chunk can skip downstream acquisition');
    });
