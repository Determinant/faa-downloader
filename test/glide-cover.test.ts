import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { glideCoverClass, prepareGlideRasterRole } from '../lib/glide-sources.ts';
import { sha256File } from '../lib/fs-utils.ts';
import { terrainCommand } from '../lib/terrain-raster.ts';
import { parseGlideCanopyService } from '../lib/glide-canopy.ts';
import { glideGrid, type ResolvedRegion } from '../lib/glide-model.ts';
import { readGlideSurface, readGlideGround } from '../lib/glide-raster.ts';
import type { GlideRasterSources } from '../lib/glide-sources.ts';

let hasGdal = true;
try { execFileSync('gdal', ['raster', 'calc', '--help'], { stdio: 'ignore' }); } catch { hasGdal = false; }

test('native masks preserve open-field mixtures, reject tree/shrub/water/unknown contributors, and flag cultivated land',
    { skip: hasGdal ? false : 'Requires GDAL 3.11' }, async t => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-cover-'));
        t.after(() => fs.rm(directory, { recursive: true, force: true }));
        const cases = [
            { role: 'landcover' as const, values: [71, 81, 81, 82, 52, 81, 11, 81, 255, 81], expected: [1, 1, 0, 0, 0] },
            { role: 'canopy' as const, values: [4, 5, 5, 6, 0, 50, 0, 100, 0, 255], expected: [2, 1, 0, 0, 0] },
            { role: 'impervious' as const, values: [0, 0, 0, 1, 0, 50, 0, 100, 0, 255], expected: [3, 2, 1, 0, 0] },
            { role: 'shrubCover' as const, values: [0, 10, 10, 11, 20, 60, 60, 61, 0, 101], expected: [3, 2, 1, 0, 0] },
            { role: 'shrubHeight' as const, values: [0, 30, 30, 31, 50, 100, 100, 101, 0, 501], expected: [3, 2, 1, 0, 0] },
            { role: 'shrubTreeCover' as const, values: [0, 0, 0, 1, 0, 5, 0, 50, 0, 101], expected: [1, 0, 0, 0, 0] },
            { role: 'fineLandcover' as const, values: [30, 40, 30, 10, 60, 80, 30, 255, 60, 30], expected: [2, 2, 1, 0, 1] },
        ];
        for (const { role, values, expected } of cases) {
            const raw = path.join(directory, `${role}.bin`), file = path.join(directory, `${role}.tif`);
            await fs.writeFile(raw, Uint8Array.from(values));
            await fs.writeFile(raw.replace('.bin', '.hdr'), 'ENVI\nsamples = 10\nlines = 1\nbands = 1\n' +
                'header offset = 0\nfile type = ENVI Standard\ndata type = 1\ninterleave = bsq\nbyte order = 0\n' +
                'map info = {Geographic Lat/Lon, 1, 1, 0, 0.00005, 0.00005, 0.00005, WGS-84, units=Degrees}\n');
            await terrainCommand('gdal_translate', ['-q', '-of', 'GTiff', '-a_nodata', '255', raw, file]);
            const asset = { name: role, date: '2025-12-31', attribution: 'Fixture', file,
                sha256: await sha256File(file), bytes: (await fs.stat(file)).size };
            const source = await prepareGlideRasterRole([asset], role, directory);
            assert.equal(source.oldestDate, asset.date);
            assert.equal(source.newestDate, asset.date);
            const reduced = path.join(directory, `${role}-reduced.bin`);
            await terrainCommand('gdalwarp', ['-q', '-of', 'ENVI', '-ot', 'Byte', '-srcnodata', 'None', '-dstnodata', '254',
                '-r', 'min', '-ts', '5', '1', '-te', '0', '0', '0.0005', '0.00005', source.eligible!, reduced]);
            assert.deepEqual([...await fs.readFile(reduced)], expected, role);
            if (role === 'fineLandcover') {
                const maximum = path.join(directory, 'fine-excluded.bin');
                await terrainCommand('gdalwarp', ['-q', '-of', 'ENVI', '-ot', 'Byte', '-srcnodata', 'None', '-dstnodata', '254',
                    '-r', 'max', '-ts', '5', '1', '-te', '0', '0', '0.0005', '0.00005', source.excluded!, maximum]);
                assert.deepEqual([...await fs.readFile(maximum)], [0, 1, 1, 0, 0], 'tree/water contributors remain exclusions even beside open land');
            }
            if (role === 'landcover') {
                const maximum = path.join(directory, 'crop-flags.bin');
                await terrainCommand('gdalwarp', ['-q', '-of', 'ENVI', '-ot', 'Byte', '-srcnodata', 'None', '-dstnodata', '254',
                    '-r', 'max', '-ts', '5', '1', '-te', '0', '0', '0.0005', '0.00005', source.eligible!, maximum]);
                assert.deepEqual([...await fs.readFile(maximum)], [1, 2, 1, 1, 1]);
            }
        }
    });

test('canopy discovery locks the latest Science raster and rejects display/coarse/ambiguous grids', () => {
    const catalog = { features: [{ attributes: { objectid: 159, name: 'science_tcc_conus_2025',
        beginyear: 2025, endyear: 2025, category: 1 } }] };
    const info = { pixelSizeX: 30, pixelSizeY: 30, bandCount: 1, pixelType: 'U16',
        extent: { xmin: -1000, ymin: 0, xmax: 1000, ymax: 2000, spatialReference: { wkid: 102008 } } };
    assert.deepEqual(parseGlideCanopyService(catalog, info).origin, [-985, 1985]);
    assert.throws(() => parseGlideCanopyService(catalog, { ...info, pixelSizeX: 90 }), /original 30 m/);
    assert.throws(() => parseGlideCanopyService(catalog, { ...info, extent: { ...info.extent,
        spatialReference: { wkid: 3857 } } }), /original 30 m/);
    assert.throws(() => parseGlideCanopyService({ ...catalog, exceededTransferLimit: true }, info), /Incomplete/);
    assert.throws(() => parseGlideCanopyService({ features: [...catalog.features, ...catalog.features] }, info), /unique/);
    const processed = structuredClone(catalog);
    processed.features[0].attributes.name = 'nlcd_tcc_conus_2025';
    assert.throws(() => parseGlideCanopyService(processed, info), /Science/);
});

test('shrub thresholds use centimetres, preserve known zero and reject out-of-range or absent evidence', () => {
    assert.equal(glideCoverClass('landcover', 52), 0, 'custom inputs without shrub components retain old exclusions');
    assert.equal(glideCoverClass('landcover', 52, true), 3, 'only potentially eligible pending paired shrub evidence');
    for (const code of [-1, NaN, 0.5, 501, 65535]) assert.equal(glideCoverClass('shrubHeight', code), 0);
    assert.equal(glideCoverClass('shrubHeight', 30), 3);
    assert.equal(glideCoverClass('shrubHeight', 50), 2);
    assert.equal(glideCoverClass('shrubHeight', 100), 1, 'one metre is final best-effort fallback only');
    assert.equal(glideCoverClass('shrubHeight', 101), 0);
    assert.equal(glideCoverClass('shrubCover', 60), 1);
    assert.equal(glideCoverClass('shrubCover', 61), 0);
    assert.equal(glideCoverClass('shrubCover', 101), 0, 'service NoData is not zero percent');
});

test('a second tree model cannot override rejected canopy for any land class or tier',
    { skip: hasGdal ? false : 'Requires GDAL' }, async t => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-canopy-gate-'));
        t.after(() => fs.rm(directory, { recursive: true, force: true }));
        const region: ResolvedRegion = { id: 'fixture', bounds: [-98, 25, -97.99, 25.01],
            coverageBounds: [-99, 24, -97, 26], sources: {} as never };
        const grid = glideGrid(region.bounds), rasters: string[] = [];
        for (const value of [0, 1, 2, 3, 4]) {
            const name = `${value}`, file = path.join(directory, `${name}.vrt`);
            await fs.writeFile(path.join(directory, `${name}.bin`), new Uint8Array(grid.width * grid.height).fill(value));
            await fs.writeFile(file, `<VRTDataset rasterXSize="${grid.width}" rasterYSize="${grid.height}">` +
                `<SRS>${grid.srs}</SRS><GeoTransform>${grid.west},10,0,${grid.north},0,-10</GeoTransform>` +
                `<VRTRasterBand dataType="Byte" band="1" subClass="VRTRawRasterBand">` +
                `<SourceFilename relativeToVRT="1">${name}.bin</SourceFilename><ImageOffset>0</ImageOffset>` +
                `<PixelOffset>1</PixelOffset><LineOffset>${grid.width}</LineOffset></VRTRasterBand></VRTDataset>`);
            rasters.push(file);
        }
        const sources: GlideRasterSources = { elevation: { known: rasters[1], values: rasters[0] },
            landcover: { eligible: rasters[3], shrub: rasters[1] }, canopy: { eligible: rasters[1] },
            impervious: { eligible: rasters[2] }, shrubCover: { eligible: rasters[1] },
            shrubHeight: { eligible: rasters[1] }, shrubTreeCover: { eligible: rasters[1] } };
        const acquire = () => readGlideSurface(region, sources, grid, directory, {
            prepareHazards: async () => { throw new Error('Reached hazard screening'); } });
        assert.equal(await acquire(), null, 'legacy relaxed canopy cannot pass even with known zero RCMAP trees');
        sources.landcover.urban = rasters[1];
        assert.equal(await acquire(), null, 'mixed shrub/urban contributors remain excluded');
        delete sources.landcover.urban;
        for (const land of [0, 1, 2]) {
            sources.landcover.eligible = rasters[land];
            assert.equal(await acquire(), null, 'forest, open fields and crop/shrub mixtures cannot use fallback');
        }
        sources.landcover.eligible = rasters[3];
        sources.shrubTreeCover = { eligible: rasters[0] };
        assert.equal(await acquire(), null, 'nonzero or unknown native tree cover rejects the fallback');
        delete sources.shrubTreeCover;
        assert.equal(await acquire(), null, 'missing corroboration is not a zero estimate');
        sources.canopy.eligible = rasters[0];
        assert.equal(await acquire(), null, 'unknown or above-cap Science pixels remain excluded');
        sources.canopy.eligible = rasters[2];
        await assert.rejects(acquire, /Reached hazard screening/, 'strict canopy retains the existing shrub policy without extra data');
        sources.landcover = { eligible: rasters[4], urban: rasters[1] };
        sources.impervious.eligible = rasters[2];
        await assert.rejects(acquire, /Reached hazard screening/, 'urban-only low impervious allowance reaches full screening');
        for (const land of [1, 2, 3]) {
            sources.landcover.eligible = rasters[land];
            await assert.rejects(acquire, /Reached hazard screening/, 'low impervious remains potential purple ground across open classes');
        }
        sources.landcover.eligible = rasters[4]; sources.impervious.eligible = rasters[0];
        assert.equal(await acquire(), null, 'above-cap or unknown impervious cannot qualify urban open ground');
        sources.canopy.eligible = rasters[1]; sources.impervious.eligible = rasters[1];
        sources.landcover = { eligible: rasters[1], mappedOnly: rasters[1] };
        assert.equal(await readGlideGround(sources, grid, directory), null, 'broader models require mapped open ground');
        const groundFile = path.join(directory, 'ground.geojson');
        const corners = [[0, 0], [grid.width, 0], [grid.width, grid.height], [0, grid.height], [0, 0]];
        const polygon = { type: 'Polygon', coordinates: [corners.map(([x, y]) => grid.coordinate(x, y))] };
        const writeGround = async (blocked: boolean, openClass = 1) => {
            await fs.writeFile(groundFile, JSON.stringify({ type: 'FeatureCollection', features: [openClass, ...(blocked ? [3] : [])]
                .map(groundClass => ({ type: 'Feature', properties: { groundClass }, geometry: polygon })) }));
            sources.ground = [{ file: groundFile, name: 'mapped fixture', date: '2026-01-01', attribution: 'fixture',
                groundSource: 'mapped', sha256: await sha256File(groundFile), bytes: (await fs.stat(groundFile)).size }];
        };
        await writeGround(false);
        const mapped = await readGlideGround(sources, grid, directory);
        assert.ok(mapped?.cover.some(Boolean), 'mapped open polygon can qualify the broader coarse model');
        assert.ok(mapped?.canopyUncertain?.some(Boolean));
        assert.ok(mapped?.mixedOpen?.some(Boolean));
        await writeGround(true);
        assert.equal(await readGlideGround(sources, grid, directory), null, 'mapped forest/wetland wins over mapped grass');
        await writeGround(false, 2);
        assert.equal(await readGlideGround(sources, grid, directory), null, 'barren mapping does not corroborate uncertain grass or cropland');
        sources.landcover.bare = rasters[1];
        assert.ok(await readGlideGround(sources, grid, directory), 'mapped barren can support native bare/sandy ground');
        delete sources.landcover.bare;
        sources.fineLandcover = { eligible: rasters[2], excluded: rasters[0] };
        await writeGround(true);
        assert.equal(await readGlideGround(sources, grid, directory), null, 'fine cover cannot override mapped exclusion polygons');
        delete sources.ground;
        const fine = await readGlideGround(sources, grid, directory);
        assert.ok(fine?.cover.some(Boolean), 'native fine open cover corroborates a bounded coarse-model disagreement');
        assert.ok(fine?.canopyUncertain?.some(Boolean), 'recovered ground retains purple uncertainty');
        sources.fineLandcover.excluded = rasters[1];
        assert.equal(await readGlideGround(sources, grid, directory), null, 'native trees and water override positive grass evidence');
        sources.fineLandcover.excluded = rasters[0];
        sources.canopy.eligible = rasters[0];
        assert.equal(await readGlideGround(sources, grid, directory), null, 'fine cover cannot override high or unknown canopy');
        sources.canopy.eligible = rasters[1]; sources.landcover.eligible = rasters[0];
        assert.equal(await readGlideGround(sources, grid, directory), null, 'older fine cover cannot override excluded current land cover');
        sources.landcover.eligible = rasters[1]; sources.fineLandcover.eligible = rasters[0];
        assert.equal(await readGlideGround(sources, grid, directory), null, 'missing, wooded or wet fine cover cannot supply positive evidence');
        // The native mask/dates must carry corroboration into actual ground screening.
        await writeGround(false);
        sources.canopy = { eligible: rasters[2], oldestDate: '2025-01-01' };
        sources.impervious = { eligible: rasters[3] };
        sources.landcover = { eligible: rasters[1], disputed: rasters[1], oldestDate: '2025-01-01' };
        sources.fineLandcover = { eligible: rasters[2], excluded: rasters[0] };
        assert.ok((await readGlideGround(sources, grid, directory))?.coverUncertain?.some(Boolean),
            'coarse forest disagreement needs both independently mapped openings and fine grass');
        sources.fineLandcover.excluded = rasters[1];
        assert.equal(await readGlideGround(sources, grid, directory), null);
        sources.landcover.disputed = rasters[0];
        sources.fineLandcover = { eligible: rasters[3], excluded: rasters[1], trees: rasters[1], water: rasters[0],
            newestDate: '2021-12-31' };
        assert.ok((await readGlideGround(sources, grid, directory))?.coverUncertain?.some(Boolean),
            'strictly newer low-canopy mapped grass can resolve an older tree classification');
        delete sources.canopy.oldestDate;
        assert.equal(await readGlideGround(sources, grid, directory), null, 'missing source dates cannot establish recency');
        sources.canopy.oldestDate = '2021-12-31';
        assert.equal(await readGlideGround(sources, grid, directory), null, 'equal-age evidence cannot override trees');
        sources.canopy.oldestDate = '2025-01-01'; sources.fineLandcover.water = rasters[1];
        assert.equal(await readGlideGround(sources, grid, directory), null, 'even older water evidence remains excluded');

    });

test('tree-canopy thresholds do not change when shrub evidence is available', () => {
    for (const shrubs of [false, true]) {
        for (const code of [0, 1, 5]) assert.equal(glideCoverClass('canopy', code, shrubs), 2);
        for (const code of [6, 10, 20]) assert.equal(glideCoverClass('canopy', code, shrubs), 1);
        for (const code of [21, 100, 255, NaN]) assert.equal(glideCoverClass('canopy', code, shrubs), 0);
    }
});

test('mixed crop and shrub native pixels retain both flags without approving excluded contributors',
    { skip: hasGdal ? false : 'Requires GDAL' }, async t => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-shrub-flags-'));
        t.after(() => fs.rm(directory, { recursive: true, force: true }));
        const raw = path.join(directory, 'mixed.bin'), file = path.join(directory, 'mixed.tif');
        await fs.writeFile(raw, Uint8Array.from([82, 52, 71, 52, 11, 52]));
        await fs.writeFile(raw.replace('.bin', '.hdr'), 'ENVI\nsamples = 6\nlines = 1\nbands = 1\n' +
            'header offset = 0\nfile type = ENVI Standard\ndata type = 1\ninterleave = bsq\nbyte order = 0\n' +
            'map info = {Geographic Lat/Lon, 1, 1, 0, 0.00005, 0.00005, 0.00005, WGS-84, units=Degrees}\n');
        await terrainCommand('gdal_translate', ['-q', '-of', 'GTiff', '-a_nodata', '255', raw, file]);
        const asset = { name: 'mixed', date: '2025-12-31', attribution: 'Fixture', file,
            sha256: await sha256File(file), bytes: (await fs.stat(file)).size };
        const source = await prepareGlideRasterRole([asset], 'landcover', directory, directory, true);
        for (const [name, expected] of [['cultivated', [1, 0, 0]], ['shrub', [1, 1, 1]], ['eligible', [2, 1, 0]]] as const) {
            const output = path.join(directory, `${name}.bin`);
            await terrainCommand('gdalwarp', ['-q', '-of', 'ENVI', '-ot', 'Byte', '-srcnodata', 'None', '-dstnodata', '254',
                '-r', name === 'eligible' ? 'min' : 'max', '-ts', '3', '1', '-te', '0', '0', '0.0003', '0.00005', source[name]!, output]);
            assert.deepEqual([...await fs.readFile(output)], expected);
        }
    });

test('embedded raster mask holes remain excluded after classification and cached masks need no VRT rebuild',
    { skip: hasGdal ? false : 'Requires GDAL' }, async t => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-cover-mask-'));
        t.after(() => fs.rm(directory, { recursive: true, force: true }));
        const raw = path.join(directory, 'input.bin'), file = path.join(directory, 'masked.tif');
        await fs.writeFile(raw, Uint8Array.from([71, 81, 71, 81, 255, 0, 255, 255]));
        await fs.writeFile(raw.replace('.bin', '.hdr'), 'ENVI\nsamples = 4\nlines = 1\nbands = 2\n' +
            'header offset = 0\nfile type = ENVI Standard\ndata type = 1\ninterleave = bsq\nbyte order = 0\n' +
            'map info = {Geographic Lat/Lon, 1, 1, 0, 0.00005, 0.00005, 0.00005, WGS-84, units=Degrees}\n');
        await terrainCommand('gdal_translate', ['--config', 'GDAL_TIFF_INTERNAL_MASK', 'YES', '-q', '-of', 'GTiff', '-b', '1', '-mask', '2', raw, file]);
        const assets = [{ name: 'masked', date: '2025-12-31', attribution: 'Fixture', file,
            sha256: await sha256File(file), bytes: (await fs.stat(file)).size }];
        const source = await prepareGlideRasterRole(assets, 'landcover', directory);
        const output = path.join(directory, 'classified.bin');
        await terrainCommand('gdal_translate', ['-q', '-of', 'ENVI', source.eligible, output]);
        assert.deepEqual([...await fs.readFile(output)], [1, 0, 1, 1]);
        const mosaic = path.join(directory, 'landcover.vrt');
        await fs.rm(mosaic);
        assert.deepEqual(await prepareGlideRasterRole(assets, 'landcover', directory), source);
        await assert.rejects(fs.stat(mosaic), { code: 'ENOENT' });
    });


test('urban-open and developed classes retain distinct eligibility requiring mapped evidence', () => {
    assert.equal(glideCoverClass('landcover', 21), 4);
    assert.equal(glideCoverClass('landcover', 31), 5);
    for (const code of [22, 23, 24]) assert.equal(glideCoverClass('landcover', code), 6);
    for (const code of [41, 42, 43]) assert.equal(glideCoverClass('landcover', code), 7, 'potential disagreement, still needs independent evidence');
    for (const code of [90, 95, 255]) assert.equal(glideCoverClass('landcover', code), 0);
    assert.equal(glideCoverClass('impervious', 0), 3);
    assert.equal(glideCoverClass('impervious', 5), 2);
    assert.equal(glideCoverClass('impervious', 6), 1);
    assert.equal(glideCoverClass('impervious', 51), 0);
});
