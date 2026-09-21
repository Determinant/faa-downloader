import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { buildFingerprint } from '../lib/build-cache.ts';
import { buildTerrain, encodeTerrainArchive, terrainBlocks, type TerrainManifest } from '../lib/terrain.ts';
import { TERRAIN_MAX_ZOOM, TERRAIN_NODATA, terrainGridBounds, terrainGridSize, terrainSpacing } from '../lib/terrain-grid.ts';
import { renderTerrainBatch, terrainCommand, type TerrainBounds } from '../lib/terrain-raster.ts';
import { missingTerrainGrid, reduceTerrainArchive } from '../lib/terrain-overviews.ts';
import { discoverTerrainProducts, loadTerrainInputs, parseTerrainListing, parseTerrainMetadata, USGS_TERRAIN_PREFIX, USGS_TERRAIN_ROOT } from '../lib/terrain-source.ts';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const regions = [{ id: 'sample', title: 'Sample', bounds: [
    [-122.51, 37.51, -122.509, 37.511] as TerrainBounds,
    [-117.51, 37.51, -117.509, 37.511] as TerrainBounds
] }];
const metadata = '<!DOCTYPE metadata SYSTEM "https://thor-f5.er.usgs.gov/ngtoc/metadata/fgdc-std-001-1998.dtd">' +
    '<metadata><spref><vertdef><altsys><altdatum>North American Vertical Datum of 1988</altdatum>' +
    '<altunits>meters</altunits></altsys></vertdef></spref></metadata>';
const metadataFor = ([west, south, east, north]: TerrainBounds) => metadata.replace('<metadata>',
    `<metadata><idinfo><spdom><bounding><westbc>${west}</westbc><southbc>${south}</southbc>` +
    `<eastbc>${east}</eastbc><northbc>${north}</northbc></bounding></spdom></idinfo>`);
let hasGdal = true;
try { for (const command of ['gdalinfo', 'gdal_translate', 'gdalbuildvrt', 'gdalwarp']) execFileSync(command, ['--version'], { stdio: 'ignore' }); }
catch { hasGdal = false; }
const gdalTest = { skip: hasGdal ? false : 'Requires GDAL CLI tools (same prerequisites as the terrain builder)' };

async function raster(root: string, name: string, bounds: TerrainBounds, value: (lon: number, lat: number) => number, width = 128) {
    const raw = Buffer.alloc(width * width * 4);
    const dx = (bounds[2] - bounds[0]) / width, dy = (bounds[1] - bounds[3]) / width;
    for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
        raw.writeFloatLE(value(bounds[0] + (x + 0.5) * dx, bounds[3] + (y + 0.5) * dy), (y * width + x) * 4);
    }
    await fs.writeFile(path.join(root, `${name}.bin`), raw);
    await fs.writeFile(path.join(root, `${name}.vrt`), `<VRTDataset rasterXSize="${width}" rasterYSize="${width}">
<SRS>EPSG:4269</SRS><GeoTransform>${[bounds[0], dx, 0, bounds[3], 0, dy].join(',')}</GeoTransform>
<VRTRasterBand dataType="Float32" band="1" subClass="VRTRawRasterBand"><NoDataValue>-999999</NoDataValue>
<SourceFilename relativeToVRT="1">${name}.bin</SourceFilename><ImageOffset>0</ImageOffset><PixelOffset>4</PixelOffset>
<LineOffset>${width * 4}</LineOffset><ByteOrder>LSB</ByteOrder></VRTRasterBand></VRTDataset>`);
    const file = path.join(root, `${name}.tif`);
    await terrainCommand('gdal_translate', ['-q', '-of', 'GTiff', path.join(root, `${name}.vrt`), file]);
    return fs.readFile(file);
}

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
type ObjectData = { bytes: Buffer; date: string; etag: string };
function fakeUsgs() {
    const objects = new Map<string, ObjectData>();
    const calls: Array<{ url: string; range: string | null }> = [];
    let failKey = '';
    const put = (id: string, extension: string, bytes: Uint8Array | string, date = '2026-09-01T00:00:00.000Z') => {
        const key = `${USGS_TERRAIN_PREFIX}${id}/USGS_1_${id}.${extension}`;
        const data = Buffer.from(bytes); objects.set(key, { bytes: data, date, etag: `"${hash(data)}"` }); return key;
    };
    const fetcher: typeof fetch = async (input, init) => {
        const url = new URL(String(input)), headers = new Headers(init?.headers);
        calls.push({ url: url.href, range: headers.get('range') });
        if (url.searchParams.get('list-type') === '2') {
            assert.equal(url.searchParams.get('prefix'), USGS_TERRAIN_PREFIX);
            const offset = Number(url.searchParams.get('continuation-token') ?? '0');
            const entries = [...objects.entries()].sort(([a], [b]) => a.localeCompare(b));
            const page = entries.slice(offset, offset + 2), next = offset + page.length < entries.length ? offset + page.length : undefined;
            return new Response(`<ListBucketResult><Prefix>${USGS_TERRAIN_PREFIX}</Prefix><IsTruncated>${next !== undefined}</IsTruncated>` +
                (next === undefined ? '' : `<NextContinuationToken>${next}</NextContinuationToken>`) +
                page.map(([key, object]) => `<Contents><Key>${key}</Key><ETag>${escapeXml(object.etag)}</ETag>` +
                    `<Size>${object.bytes.length}</Size><LastModified>${object.date}</LastModified></Contents>`).join('') + '</ListBucketResult>');
        }
        assert.equal(url.origin + '/', USGS_TERRAIN_ROOT);
        const key = decodeURIComponent(url.pathname.slice(1)), object = objects.get(key);
        assert.ok(object, `Unexpected source request: ${key}`);
        assert.equal(headers.get('if-match'), object.etag, 'all source requests must pin the discovered version');
        if (key === failKey) return new Response(null, { status: 412 });
        const offset = Number(headers.get('range')?.match(/^bytes=(\d+)-$/)?.[1] ?? 0);
        return new Response(new Uint8Array(object.bytes.subarray(offset)), { status: offset ? 206 : 200, headers: {
            etag: object.etag, 'content-length': String(object.bytes.length - offset),
            ...(offset ? { 'content-range': `bytes ${offset}-${object.bytes.length - 1}/${object.bytes.length}` } : {})
        } });
    };
    return { put, objects, calls, fetcher, fail: (key: string) => { failKey = key; },
        downloads: (extension = 'tif') => calls.filter(call => new URL(call.url).pathname.endsWith(`.${extension}`)),
        clear: () => { calls.length = 0; } };
}

async function readArchives(root: string, manifest: TerrainManifest) {
    const archives = [];
    for (const shard of manifest.shards) {
        const bytes = await fs.readFile(path.join(root, 'charts/terrain', shard.file));
        assert.equal(bytes.length, shard.byteLength); assert.equal(hash(bytes), shard.sha256);
        archives.push(...JSON.parse(bytes.toString()).archives);
    }
    for (const archive of archives) {
        const bytes = await fs.readFile(path.join(root, 'charts/terrain', archive.file));
        assert.equal(bytes.length, archive.byteLength); assert.equal(hash(bytes), archive.sha256);
        assert.equal(bytes.subarray(0, 8).toString(), 'ZDEM0002');
        assert.equal(bytes.readUInt32LE(8), archive.zoom); assert.equal(bytes.readUInt32LE(12), archive.x);
        assert.equal(bytes.readUInt32LE(16), archive.y); assert.equal(bytes.readUInt32LE(20), 4);
        for (let i = 0; i < 4; i++) {
            const offset = bytes.readUInt32LE(24 + i * 8), length = bytes.readUInt32LE(28 + i * 8);
            assert.equal(gunzipSync(bytes.subarray(offset, offset + length)).length, 256 * 256 * 2);
        }
    }
    return archives;
}

async function setup(t: any) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usgs-terrain-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const overlap = 2 / 3600;
    const bounds = (west: number): TerrainBounds => [west - overlap, 37 - overlap, west + 1 + overlap, 38 + overlap];
    const first = await raster(root, 'first', bounds(-123), () => 123.5);
    const changed = await raster(root, 'changed', bounds(-123), () => 223.5);
    const second = await raster(root, 'second', bounds(-118), () => -0.25);
    const source = fakeUsgs();
    source.put('n38w123', 'tif', first); source.put('n38w123', 'xml', metadataFor(bounds(-123)));
    source.put('n38w118', 'tif', second); source.put('n38w118', 'xml', metadataFor(bounds(-118)));
    const logs: string[] = [];
    const options = { fetch: source.fetcher, logger: { log: (s: string) => logs.push(s), warn: (s: string) => logs.push(s) } };
    return { root, source, options, changed, logs };
}

test('USGS listing validates opaque ETags, pagination and height metadata', async () => {
    const source = fakeUsgs();
    source.put('n38w123', 'tif', 'raster'); source.put('n38w123', 'xml', metadata);
    source.put('n14e144', 'tif', 'outside'); source.put('n14e144', 'xml', metadata);
    const products = await discoverTerrainProducts(regions, source.fetcher);
    assert.deepEqual(products.map(p => p.id), ['n38w123']);
    assert.equal(source.calls.length, 2, 'catalog is paginated before selecting source files');
    assert.equal(source.downloads().length, 0, 'discovery does not fetch raster bodies');
    assert.throws(() => parseTerrainListing('<ListBucketResult><Prefix>wrong</Prefix></ListBucketResult>'));
    assert.throws(() => parseTerrainListing(`<ListBucketResult><Prefix>${USGS_TERRAIN_PREFIX}</Prefix><IsTruncated>true</IsTruncated></ListBucketResult>`));
    assert.throws(() => parseTerrainMetadata(metadata.replace('meters', 'feet')));
    assert.throws(() => parseTerrainMetadata('<!DOCTYPE metadata [<!ENTITY injected "test">]>' + metadata));
    assert.throws(() => parseTerrainMetadata(metadata.replace('North American Vertical Datum of 1988', 'WGS84 ellipsoid')));
    assert.equal(parseTerrainMetadata(metadata).verticalDatum, 'North American Vertical Datum of 1988');
});

test('USGS discovery selects only 1-arc-second tiles from mixed-product listings', async () => {
    const source = fakeUsgs();
    const key = source.put('n30w090', 'tif', '1-arc-second raster');
    const xml = source.put('n30w090', 'xml', metadata);
    // The live 1/TIFF/current/ directory also contains this stray 1/3-arc-second file.
    source.objects.set(key.replace('/USGS_1_', '/USGS_13_'), source.objects.get(key)!);
    const selectedRegions = [{ id: 'sample', title: 'Sample', bounds: [[-89.51, 29.51, -89.509, 29.511] as TerrainBounds] }];
    const products = await discoverTerrainProducts(selectedRegions, source.fetcher);
    assert.deepEqual(products.map(product => product.key), [key]);
    assert.equal(products[0].metadata.key, xml);
    assert.equal(source.downloads().length, 0);

    source.objects.delete(xml);
    await assert.rejects(discoverTerrainProducts(selectedRegions, source.fetcher), /Missing USGS terrain metadata/);
    source.objects.delete(key);
    await assert.rejects(discoverTerrainProducts(selectedRegions, source.fetcher), /No current USGS 3DEP 1-arc-second terrain/);
});

test('USGS discovery still rejects inconsistent tile identifiers within the selected product', async () => {
    const source = fakeUsgs();
    const key = source.put('n38w123', 'tif', 'raster');
    source.objects.set(key.replace('USGS_1_n38w123', 'USGS_1_n39w123'), source.objects.get(key)!);
    source.objects.delete(key);
    await assert.rejects(discoverTerrainProducts(regions, source.fetcher), /Unrecognized current USGS terrain tile/);
});

test('online USGS downloads accept the measured 1-arc-second footprint and reject misplaced rasters', gdalTest, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'terrain-footprint-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    // Bounds measured by gdalinfo on the official USGS_1_n38w123.tif, independent of discovery's estimate.
    const bounds: TerrainBounds = [-123.00055555579371, 36.999444443707, -121.99944444360564, 38.00055555589506];
    const source = fakeUsgs();
    source.put('n38w123', 'tif', await raster(root, 'measured', bounds, () => 123.5));
    source.put('n38w123', 'xml', metadataFor(bounds));
    const options = { fetch: source.fetcher, logger: { log() {}, warn() {} } };
    const cache = path.join(root, 'cache');
    const inputs = await loadTerrainInputs(regions, cache, options);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].id, 'n38w123');
    assert.equal(source.downloads().length, 1, 'exercise download validation rather than local imports');
    source.put('n38w123', 'tif', await raster(root, 'misplaced', [-122, 37, -121, 38], () => 123.5));
    await assert.rejects(loadTerrainInputs(regions, cache, options), /footprint disagrees/);
});

test('USGS island tiles retain their wider measured footprint on download and cache reuse', gdalTest, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'terrain-island-footprint-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    // Actual USGS_1_n18w065 GeoTIFF bounds: 3612 cells, with six arc-seconds of border.
    const bounds: TerrainBounds = [-65.00166666718223, 16.99833333351739, -63.998333332916204, 18.001666666884034];
    const source = fakeUsgs();
    source.put('n18w065', 'tif', await raster(root, 'island', bounds, () => 123.5));
    source.put('n18w065', 'xml', metadataFor(bounds));
    const selectedRegions = [{ id: 'island', title: 'Island', bounds: [[-64.51, 17.51, -64.509, 17.511] as TerrainBounds] }];
    const cache = path.join(root, 'cache'), options = { fetch: source.fetcher, logger: { log() {}, warn() {} } };
    const first = await loadTerrainInputs(selectedRegions, cache, options);
    assert.equal(first.length, 1);
    assert.ok(first[0].bounds.every((n, i) => Math.abs(n - bounds[i]) < 1e-9), 'dependencies use measured raster bounds');
    source.clear();
    assert.deepEqual(await loadTerrainInputs(selectedRegions, cache, options), first);
    assert.equal(source.downloads().length, 0);

    // A changed sidecar must still belong to the named tile without discarding cached data.
    source.put('n18w065', 'xml', metadataFor([bounds[0], bounds[1], bounds[2] - 0.1, bounds[3]]));
    await assert.rejects(loadTerrainInputs(selectedRegions, cache, options), /metadata footprint disagrees/);
    assert.equal(source.downloads().length, 0, 'invalid metadata must not discard or redownload a verified raster');
    source.put('n18w065', 'xml', metadataFor([-64, 17, -63, 18]));
    await assert.rejects(loadTerrainInputs(selectedRegions, cache, options), /metadata footprint disagrees/);
    source.put('n18w065', 'xml', metadata);
    await assert.rejects(loadTerrainInputs(selectedRegions, cache, options), /geographic footprint/);
    source.put('n18w065', 'xml', metadataFor([0, 17, -64, 18]));
    await assert.rejects(loadTerrainInputs(selectedRegions, cache, options), /geographic footprint/);
});

test('USGS footprints allow asymmetric grids, legacy metadata borders and clipped date-line edges', gdalTest, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'terrain-regional-footprint-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    // Real grid/sidecar footprints; some Alaska XML retains a wider border than the raster.
    const cases: Array<{ id: string; bounds: TerrainBounds; declaredBounds?: TerrainBounds }> = [
        { id: 'n28w097', bounds: [-97.0016674427, 26.9980557715, -95.9980563235, 28.0016668907] },
        { id: 'n59w159', bounds: [-159.00166666668, 57.998333325320004, -157.99833332532, 59.00166666668],
            declaredBounds: [-159.003333291, 57.9966666166, -157.996666616, 59.0033332913] },
        { id: 'n52e179', bounds: [178.99833333351773, 50.998333333017854, 180, 52.001666666384494] }
    ];
    const source = fakeUsgs();
    for (const { id, bounds, declaredBounds } of cases) {
        source.put(id, 'tif', await raster(root, id, bounds, () => 12.5));
        source.put(id, 'xml', metadataFor(declaredBounds ?? bounds));
    }
    const selectedRegions = cases.map(({ id, bounds }) => {
        const lon = (bounds[0] + bounds[2]) / 2, lat = (bounds[1] + bounds[3]) / 2;
        return { id, title: id, bounds: [[lon, lat, lon + 0.001, lat + 0.001] as TerrainBounds] };
    });
    const inputs = await loadTerrainInputs(selectedRegions, path.join(root, 'cache'),
        { fetch: source.fetcher, logger: { log() {}, warn() {} } });
    assert.equal(inputs.length, cases.length);
    for (const { id, bounds } of cases) {
        const input = inputs.find(input => input.id === id)!;
        assert.ok(input.bounds.every((n, i) => Math.abs(n - bounds[i]) < 1e-9), `${id} retains its measured footprint`);
    }
});

test('geographic GDAL conversion rounds metres upward and preserves negative/missing quadrants', gdalTest, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'terrain-numeric-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const zoom = 10, x = 164, y = 150, bounds = terrainGridBounds(zoom, x, y);
    const midLon = (bounds[0] + bounds[2]) / 2, midLat = (bounds[1] + bounds[3]) / 2;
    await raster(root, 'quadrants', bounds, (lon, lat) =>
        lat > midLat ? (lon < midLon ? 123.5 : -12.25) : (lon < midLon ? 300 : -999999));
    const grids = await renderTerrainBatch({ zoom, x, y, span: 2, blocks: [{ zoom, x, y }] },
        [path.join(root, 'quadrants.tif')], root);
    const sample = (i: number) => grids[i].readInt16LE((128 * 256 + 128) * 2);
    assert.equal(sample(0), 124); assert.equal(sample(1), -12);
    assert.equal(sample(2), 300); assert.equal(sample(3), TERRAIN_NODATA);
    const encoded = encodeTerrainArchive(zoom, x, y, grids);
    for (let i = 0; i < 4; i++) {
        const offset = encoded.readUInt32LE(24 + 8 * i), length = encoded.readUInt32LE(28 + 8 * i);
        assert.deepEqual(gunzipSync(encoded.subarray(offset, offset + length)), grids[i]);
    }
    assert.throws(() => encodeTerrainArchive(zoom, x + 1, y, grids));
});

test('2.45-arc-second cells preserve narrow source peaks and have the same angular spacing at all latitudes', gdalTest, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'terrain-peak-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    assert.equal(terrainSpacing(TERRAIN_MAX_ZOOM) * 3600, 2.45);
    for (let z = 1; z <= 10; z++) assert.equal(terrainSpacing(z), 4.9 / 3600 * 2 ** (10 - z), 'existing grid levels remain aligned');
    for (const y of [60, 150, 400]) {
        const bounds = terrainGridBounds(TERRAIN_MAX_ZOOM, 328, y);
        assert.ok(Math.abs((bounds[3] - bounds[1]) / 512 * 3600 - 2.45) < 1e-10);
    }
    const zoom = TERRAIN_MAX_ZOOM, x = 328, y = 300, bounds = terrainGridBounds(zoom, x, y);
    const step = terrainSpacing(zoom), left = bounds[0] + 100 * step, top = bounds[3] - 100 * step;
    await raster(root, 'peak', bounds, (lon, lat) => lon >= left && lon < left + step / 2 &&
        lat <= top && lat > top - step / 2 ? 9321.25 : 10.1, 1024);
    const grids = await renderTerrainBatch({ zoom, x, y, span: 2, blocks: [{ zoom, x, y }] },
        [path.join(root, 'peak.tif')], root);
    assert.equal(grids[0].readInt16LE((100 * 256 + 100) * 2), 9322, 'a single fine source peak survives aggregation');
    assert.equal(grids[0].readInt16LE(0), 11);
    assert.equal(encodeTerrainArchive(zoom, x, y, grids).readUInt32LE(8), 11);
});

test('mixed-resolution mosaics preserve single-cell peaks from the finer raster', gdalTest, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'terrain-mixed-resolution-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const zoom = 10, x = 164, y = 150, bounds = terrainGridBounds(zoom, x, y);
    const west = bounds[0], north = bounds[3], span = 128 / 3600;
    let sample = 0;
    await raster(root, 'fine', [west, north - span, west + span, north], () => sample++ === 129 ? 9321.25 : 0);
    await raster(root, 'coarse', [west + span, north - 2 * span, west + 3 * span, north], () => 0);
    const fine = path.join(root, 'fine.tif'), coarse = path.join(root, 'coarse.tif');
    for (const files of [[fine], [fine, coarse], [coarse, fine]]) {
        const grids = await renderTerrainBatch({ zoom, x, y, span: 2, blocks: [{ zoom, x, y }] }, files, root);
        assert.equal(grids[0].readInt16LE(0), 9322, 'an adjacent coarser source must not erase the fine source peak');
    }
});

test('overview reduction preserves quadrant positions, negative peaks and missing cells', () => {
    const grids = Array.from({ length: 4 }, () => missingTerrainGrid());
    for (let q = 0; q < 4; q++) {
        grids[q].writeInt16LE(-500, 0);
        grids[q].writeInt16LE(-400, 2);
        grids[q].writeInt16LE(-100 - q, 512);
    }
    grids[2].writeInt16LE(9322, (237 * 256 + 155) * 2);
    const reduced = reduceTerrainArchive(encodeTerrainArchive(10, 164, 150, grids));
    for (let q = 0; q < 4; q++) {
        const offset = ((Math.floor(q / 2) * 128) * 256 + (q % 2) * 128) * 2;
        assert.equal(reduced.readInt16LE(offset), -100 - q);
        assert.equal(reduced.readInt16LE(offset + 2), TERRAIN_NODATA);
    }
    assert.equal(reduced.readInt16LE(((128 + 118) * 256 + 77) * 2), 9322);
    assert.throws(() => reduceTerrainArchive(Buffer.from('truncated')));
});

test('every overview retains a native peak and builds after the finest level', gdalTest, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'terrain-pyramid-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dir = path.join(root, 'source'); await fs.mkdir(dir);
    const bounds = terrainGridBounds(10, 164, 150), step = terrainSpacing(10);
    const left = bounds[0] + 100 * step, top = bounds[3] - 100 * step;
    await raster(dir, 'peak', bounds, (lon, lat) => lon >= left && lon < left + step / 2 &&
        lat <= top && lat > top - step / 2 ? 9321.25 : -12.25, 1024);
    await fs.writeFile(path.join(dir, 'peak.xml'), metadata);
    const logs: string[] = [];
    const manifest = await buildTerrain(root, [{ id: 'peak', title: 'Peak',
        bounds: [[left, top - step, left + step, top]] }],
    { sourceDirectory: dir, logger: { log: s => logs.push(s), warn: s => logs.push(s) } });
    const archives = await readArchives(root, manifest);
    assert.equal(manifest.maxZoom, 11);
    assert.equal(manifest.resolutionArcSeconds, 2.45);
    for (let zoom = 1; zoom <= TERRAIN_MAX_ZOOM; zoom++) {
        let maximum = TERRAIN_NODATA;
        for (const archive of archives.filter(a => a.zoom === zoom)) {
            const bytes = await fs.readFile(path.join(root, 'charts/terrain', archive.file));
            for (let q = 0; q < 4; q++) {
                const offset = bytes.readUInt32LE(24 + q * 8), length = bytes.readUInt32LE(28 + q * 8);
                const grid = gunzipSync(bytes.subarray(offset, offset + length));
                if (zoom === 9 && q !== 2) {
                    for (let i = 0; i < grid.length; i += 2) assert.equal(grid.readInt16LE(i), TERRAIN_NODATA,
                        'unpackaged child areas must remain missing in the overview');
                }
                for (let i = 0; i < grid.length; i += 2) maximum = Math.max(maximum, grid.readInt16LE(i));
            }
        }
        assert.equal(maximum, 9322, `level ${zoom} must retain the native peak`);
    }
    const rendering = logs.filter(line => /rendering \d+ source rasters/.test(line));
    assert.equal(rendering.length, 1, 'only the finest level reads source rasters');
    assert.match(rendering[0], /batch 1\/11, level 11/);
    assert.ok(logs.some(line => /batch 11\/11, level 1: complete/.test(line)), 'small builds report progress too');
});

test('unchanged USGS files require only catalog requests; revisions rebuild affected batches and repair metadata', gdalTest, async t => {
    const { root, source, options, changed, logs } = await setup(t);
    const first = await buildTerrain(root, regions, options);
    assert.equal(source.downloads().length, 2);
    const archives = await readArchives(root, first);
    assert.equal(archives.length, terrainBlocks(regions).length);
    const manifestFile = path.join(root, 'charts/terrain/manifest.json');
    const mtime = (await fs.stat(manifestFile)).mtimeMs;
    source.clear();
    assert.deepEqual(await buildTerrain(root, regions, options), first);
    assert.equal(source.downloads().length, 0); assert.equal(source.downloads('xml').length, 0);
    assert.ok(source.calls.length > 0, 'always check upstream versions');
    assert.equal((await fs.stat(manifestFile)).mtimeMs, mtime, 'unchanged manifest must not be republished');
    source.put('n38w123', 'tif', changed);
    source.clear(); logs.length = 0;
    const updated = await buildTerrain(root, regions, options);
    assert.equal(source.downloads().length, 1);
    assert.match(source.downloads()[0].url, /n38w123/);
    const newArchives = await readArchives(root, updated);
    const oldFiles = new Set(archives.map(a => a.file));
    assert.ok(newArchives.some(a => oldFiles.has(a.file)), 'unaffected archives retain their identities');
    assert.ok(newArchives.some(a => !oldFiles.has(a.file)), 'changed heights produce new archives');
    assert.ok(logs.some(s => /[1-9]\d* batches reused/.test(s)), 'unaffected batches skip GDAL processing');
    source.clear();
    const previousMetadata = source.objects.get(`${USGS_TERRAIN_PREFIX}n38w123/USGS_1_n38w123.xml`)!.bytes.toString();
    source.put('n38w123', 'xml', previousMetadata.replace('</metadata>', '<metainfo>revised metadata</metainfo></metadata>'));
    const revisedMetadata = await buildTerrain(root, regions, options);
    assert.equal(source.downloads().length, 0, 'metadata-only updates must not redownload elevation data');
    assert.equal(source.downloads('xml').length, 1);
    assert.deepEqual(revisedMetadata.shards, updated.shards);
    assert.notEqual(revisedMetadata.provenance.sha256, updated.provenance.sha256);
    await fs.writeFile(manifestFile, '{broken');
    await fs.writeFile(path.join(root, 'charts/terrain', newArchives[0].file), 'broken');
    source.clear();
    const repaired = await buildTerrain(root, regions, options);
    assert.equal(source.downloads().length, 0);
    assert.deepEqual(repaired.shards, revisedMetadata.shards);
    await readArchives(root, repaired);
    source.clear();
    await buildTerrain(root, regions, { ...options, rebuild: true });
    assert.equal(source.downloads().length, 0, '--rebuild still uses verified source cache');
});

test('failed source update preserves publication and completed downloads survive the next run', gdalTest, async t => {
    const { root, source, options, changed } = await setup(t);
    await buildTerrain(root, regions, options);
    const manifestFile = path.join(root, 'charts/terrain/manifest.json'), before = await fs.readFile(manifestFile);
    source.put('n38w123', 'tif', changed);
    // Change a second object too, then fail its pinned request while the first completes.
    const other = await raster(root, 'other-change', [-118 - 2 / 3600, 37 - 2 / 3600, -117 + 2 / 3600, 38 + 2 / 3600], () => 75);
    const failKey = source.put('n38w118', 'tif', other); source.fail(failKey); source.clear();
    await assert.rejects(buildTerrain(root, regions, options), /412/);
    assert.deepEqual(await fs.readFile(manifestFile), before);
    source.fail(''); source.clear();
    await buildTerrain(root, regions, options);
    assert.equal(source.downloads().length, 1, 'successfully downloaded revisions survive a failed build');
    assert.match(source.downloads()[0].url, /n38w118/);
});

test('partial source transfers resume only their pinned revision, and corrupt source caches are repaired', gdalTest, async t => {
    const { root, source, options, changed } = await setup(t);
    const products = await discoverTerrainProducts(regions, source.fetcher);
    const product = products.find(p => p.id === 'n38w123')!;
    const identity = buildFingerprint({ url: product.url, etag: product.etag, byteLength: product.byteLength });
    const cache = path.join(root, 'terrain-cache');
    const file = path.join(cache, 'objects', `${identity}.tif`);
    const offset = 20000;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.part`, source.objects.get(product.key)!.bytes.subarray(0, offset));
    source.clear();
    await loadTerrainInputs(regions, cache, options);
    assert.equal(source.downloads().find(c => c.url === product.url)!.range, `bytes=${offset}-`);
    source.clear();
    const current = source.objects.get(product.key)!;
    current.date = '2026-09-02T00:00:00.000Z';
    await loadTerrainInputs(regions, cache, options);
    assert.equal(source.downloads().length, 0, 'a timestamp-only change with the same strong ETag preserves the cached body');
    await fs.writeFile(file, Buffer.alloc(product.byteLength));
    source.clear();
    await loadTerrainInputs(regions, cache, options);
    assert.equal(source.downloads().length, 1, 'matching size alone must not hide corruption');
    await fs.writeFile(`${file}.part`, source.objects.get(product.key)!.bytes.subarray(0, offset));
    source.put('n38w123', 'tif', changed); source.clear();
    await loadTerrainInputs(regions, cache, options);
    assert.equal(source.downloads().length, 1);
    assert.equal(source.downloads()[0].range, null, 'a new ETag must never resume the old revision’s partial');
});

test('local GeoTIFF inputs record datums, preserve missing samples and recover from damaged receipts', gdalTest, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'terrain-local-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dir = path.join(root, 'source'); await fs.mkdir(dir);
    await raster(dir, 'local', [-123, 37, -122, 38], lon => lon < -122.5 ? 12.5 : -999999);
    await fs.writeFile(path.join(dir, 'local.xml'), metadata.replace('North American Vertical Datum of 1988', 'Local mean sea level'));
    const localRegions = [{ id: 'local', title: 'Local', bounds: [[-122.51, 37.51, -122.49, 37.52] as TerrainBounds] }];
    const first = await buildTerrain(root, localRegions, { sourceDirectory: dir });
    const provenance = JSON.parse(await fs.readFile(path.join(root, 'charts/terrain', first.provenance.file), 'utf8'));
    assert.equal(provenance.sources[0].metadata.verticalDatum, 'Local mean sea level');
    const records = await fs.readdir(path.join(root, 'terrain-cache/batches'), { recursive: true });
    const record = records.find(name => name.endsWith('.json') && !name.endsWith('.build.json'))!;
    await fs.writeFile(path.join(root, 'terrain-cache/batches', record), '{broken');
    assert.deepEqual((await buildTerrain(root, localRegions, { sourceDirectory: dir })).shards, first.shards);
    await fs.writeFile(path.join(dir, 'local.xml'), metadata.replace('meters', 'feet'));
    const before = await fs.readFile(path.join(root, 'charts/terrain/manifest.json'));
    await assert.rejects(buildTerrain(root, localRegions, { sourceDirectory: dir }), /metres/);
    assert.deepEqual(await fs.readFile(path.join(root, 'charts/terrain/manifest.json')), before);
});

test('date-line envelopes select both sides without covering the globe', () => {
    const blocks = terrainBlocks([{ id: 'islands', title: 'Islands', bounds: [[179.9, 51, 180, 51.01], [-180, 51, -179.9, 51.01]] }]);
    for (const zoom of [10, 11]) {
        assert.ok(blocks.some(a => a.zoom === zoom && a.x === 0));
        assert.ok(blocks.some(a => a.zoom === zoom && a.x === ((terrainGridSize(zoom).columns - 1) & ~1)));
    }
    assert.ok(blocks.length < 100);
    assert.equal(new Set(blocks.map(a => `${a.zoom}/${a.x}/${a.y}`)).size, blocks.length);
});

for (const zoom of [10, 11]) test(`level ${zoom} eastern edge tiles retain valid cells and pad the rest with NoData`, gdalTest, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'terrain-edge-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const x = (terrainGridSize(zoom).columns - 1) & ~1, y = 100;
    const bounds = terrainGridBounds(zoom, x, y);
    await raster(root, 'edge', bounds, () => 20.5);
    const grids = await renderTerrainBatch({ zoom, x, y, span: 2, blocks: [{ zoom, x, y }] },
        [path.join(root, 'edge.tif')], root);
    const columns = Math.ceil(360 / terrainSpacing(zoom)) - x * 256;
    const sample = (column: number) => grids[Math.floor(column / 256)].readInt16LE((128 * 256 + column % 256) * 2);
    assert.equal(sample(1), 21);
    assert.equal(sample(columns - 2), 21);
    for (let column = columns; column < 512; column++) assert.equal(sample(column), TERRAIN_NODATA);
});
