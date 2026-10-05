import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GdalPool, gdalCommand, gdalCli } from '../lib/gdal.ts';

test('persistent GDAL queues work, preserves min/max with excluded zeros and NoData, and recovers from command errors', async t => {
    try { await gdalCli('gdalinfo', ['--version']); }
    catch { t.skip('Requires GDAL'); return; }
    const pool = await GdalPool.create(2);
    t.after(() => pool.close());
    if (!pool.library) { t.skip('Requires matching native GDAL library'); return; }
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'gdal-'));
    t.after(() => fs.rm(work, { recursive: true, force: true }));
    const raster = path.join(work, 'input.vrt');
    await fs.writeFile(path.join(work, 'input.bin'), new Uint8Array([0, 1, 254, 254, 1, 1, 254, 254]));
    await fs.writeFile(raster, '<VRTDataset rasterXSize="4" rasterYSize="2"><SRS>EPSG:4326</SRS>' +
        '<GeoTransform>0,1,0,2,0,-1</GeoTransform><VRTRasterBand dataType="Byte" band="1" subClass="VRTRawRasterBand">' +
        '<NoDataValue>254</NoDataValue><SourceFilename relativeToVRT="1">input.bin</SourceFilename>' +
        '<PixelOffset>1</PixelOffset><LineOffset>4</LineOffset></VRTRasterBand></VRTDataset>');
    await pool.run(async () => {
        const reduce = async (resampling: string, i: number, persistent: boolean) => {
            const file = path.join(work, `${persistent}-${i}.bin`);
            const args = ['-q', '-overwrite', '-of', 'ENVI', '-ot', 'Byte', '-r', resampling,
                '-ts', '2', '1', '-dstnodata', '254', raster, file];
            await (persistent ? gdalCommand : gdalCli)('gdalwarp', args);
            return fs.readFile(file);
        };
        const expected = await Promise.all(['min', 'max'].map((r, i) => reduce(r, i, false)));
        assert.deepEqual([...expected[0]], [0, 254]);
        assert.deepEqual([...expected[1]], [1, 254]);
        const results = await Promise.all(Array.from({ length: 8 }, (_, i) => reduce(i % 2 ? 'max' : 'min', i, true)));
        results.forEach((result, i) => assert.deepEqual(result, expected[i % 2]));
        await assert.rejects(gdalCommand('gdalinfo', ['-json', path.join(work, 'missing.tif')]), /gdalinfo failed/);
        const info = JSON.parse(await gdalCommand('gdalinfo', ['-json', raster]));
        assert.deepEqual(info.size, [4, 2]);

        // Transient options must reset after both success and failure in a reused process.
        const serial = await GdalPool.create(1, { library: pool.library, version: pool.version });
        try {
            const tif = path.join(work, 'input.tif');
            await serial.command('gdal_translate', ['-q', '-of', 'GTiff', raster, tif]);
            const stripped = JSON.parse(await serial.command('gdalinfo', ['--config', 'GDAL_GEOREF_SOURCES', 'NONE', '-json', tif]));
            assert.equal(stripped.geoTransform, undefined);
            assert.ok(JSON.parse(await serial.command('gdalinfo', ['-json', tif])).geoTransform);
            await assert.rejects(serial.command('gdalinfo', ['--config', 'GDAL_GEOREF_SOURCES', 'NONE', '-json', path.join(work, 'missing.tif')]));
            assert.ok(JSON.parse(await serial.command('gdalinfo', ['-json', tif])).geoTransform);

            // GeoJSON reports the parser cause before its generic open failure.
            // Both must survive native IPC, without leaking into the next job.
            const malformed = path.join(work, 'malformed.geojson');
            await fs.writeFile(malformed, '{"type":"FeatureCollection","features":[{"type":"Feature","properties":!}]}');
            await assert.rejects(serial.command('ogrinfo', ['-so', '-al', malformed]), error => {
                assert.match((error as Error).message, /Unexpected character|JSON parsing error/i);
                assert.match((error as Error).message, /Failed to read GeoJSON data/);
                return true;
            });
            await assert.rejects(serial.command('gdalinfo', ['-json', path.join(work, 'missing.tif')]), error => {
                assert.doesNotMatch((error as Error).message, /GeoJSON|Unexpected character|JSON parsing error/i);
                return true;
            });
            assert.ok(JSON.parse(await serial.command('gdalinfo', ['-json', tif])).geoTransform);

            // Both mosaic invocation forms used by terrain and glide keep the same pixels.
            const list = path.join(work, 'inputs.txt');
            await fs.writeFile(list, `${tif}\n`);
            for (const fromList of [false, true]) {
                const vrt = path.join(work, `mosaic-${fromList}.vrt`);
                const options = ['-q', '-strict', '-overwrite', '-resolution', 'highest', '-vrtnodata', '254'];
                const args = fromList ? [...options, '-input_file_list', list, vrt] : [...options, vrt, tif];
                await serial.command('gdalbuildvrt', args);
                const actual = JSON.parse(await serial.command('gdalinfo', ['-json', '-checksum', vrt]));
                const expected = JSON.parse(await gdalCli('gdalinfo', ['-json', '-checksum', tif]));
                assert.equal(actual.bands[0].checksum, expected.bands[0].checksum);
            }

            // Closing drains accepted FIFO work and rejects anything submitted afterward.
            const queued = Array.from({ length: 5 }, () => serial.command('gdalinfo', ['-json', raster]));
            const closing = serial.close();
            await assert.rejects(serial.command('gdalinfo', ['-json', raster]), /closed/);
            const results = await Promise.all(queued);
            assert.equal(results.length, 5);
            await closing;
            await serial.close();
        } finally { await serial.close(); }
    });
});
