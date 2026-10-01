import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanGenerated, migratePdfBooks } from '../clean-generated.ts';
import { migrateChartSources } from '../lib/chart-source-layout.ts';
import { migrateNavSources } from '../lib/nav-source-layout.ts';
import { jsonArtifact } from '../lib/publication.ts';

test('generated cleanup moves inputs out of publication and compacts navigation idempotently', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-generated-clean-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const cycle = '2026-09-03';
    const published = path.join(root, 'charts', cycle);
    const nav = path.join(published, 'nav');
    const supplements = path.join(published, 'cs');
    const oldSources = path.join(published, 'nasr');
    await fs.mkdir(nav, { recursive: true });
    await fs.mkdir(supplements);
    await fs.mkdir(oldSources);
    await fs.writeFile(path.join(published, 'sectional.tif'), 'raster');
    await fs.writeFile(path.join(oldSources, 'APT_CSV.zip'), 'archive');

    const product = async (id: string, contents: string) => {
        const sha256 = createHash('sha256').update(contents).digest('hex');
        const file = `${id}.${sha256}.json`;
        await fs.writeFile(path.join(nav, file), contents);
        return { id, file, bytes: Buffer.byteLength(contents), sha256 };
    };
    const airports = await product('airports', '{}\n');
    const fixes = { ...await product('fixes', JSON.stringify({ features: [
        { properties: { kind: 'vfr-waypoint' } }, { properties: { kind: 'fix' } }
    ] }) + '\n'), count: 2 };
    const waypoints = await product('vfr-waypoints', '[]\n');
    const coverage = await product('nasr-coverage', '{"rows":1}\n');
    const cifp = await product('cifp-source', '{"group":"CIFP"}\n');
    await fs.writeFile(path.join(nav, 'manifest.json'), JSON.stringify({
        schemaVersion: 2, products: [airports, fixes, waypoints, coverage, cifp]
    }));
    await fs.writeFile(path.join(supplements, 'catalog.json'), JSON.stringify({
        schemaVersion: 2, builderVersion: 2, generatedAt: '2026-09-03T00:00:00.000Z',
        sourceXml: { url: 'https://example.invalid/index.xml', sha256: 'source' },
        volumes: [], airports: [], expected: [{ faaId: 'ABC' }]
    }));

    await cleanGenerated(root);
    await cleanGenerated(root);

    const manifest = JSON.parse(await fs.readFile(path.join(nav, 'manifest.json'), 'utf8'));
    assert.equal(manifest.schemaVersion, 3);
    assert.deepEqual(manifest.products.map((item: { id: string }) => item.id), ['airports', 'fixes']);
    assert.equal(manifest.products.find((item: { id: string }) => item.id === 'fixes').vfrWaypointCount, 1);
    assert.deepEqual((await fs.readdir(nav)).sort(), [airports.file, fixes.file, 'manifest.json'].sort());
    assert.equal(await fs.readFile(path.join(root, 'sources', cycle, 'charts', 'sectional.tif'), 'utf8'), 'raster');
    assert.equal(await fs.readFile(path.join(root, 'sources', cycle, 'nav', 'APT_CSV.zip'), 'utf8'), 'archive');
    assert.equal(await fs.readFile(path.join(root, 'sources', cycle, 'nav', 'coverage.json'), 'utf8'), '{"rows":1}\n');
    const catalog = JSON.parse(await fs.readFile(path.join(supplements, 'catalog.json'), 'utf8'));
    assert.equal(catalog.schemaVersion, 3);
    assert.equal(catalog.builderVersion, 3);
    assert.equal(Object.hasOwn(catalog, 'expected'), false);
    assert.deepEqual((await fs.readdir(published)).sort(), ['cs', 'nav']);
});

test('generated cleanup tolerates absent local caches and an empty output root', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-generated-no-cache-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await cleanGenerated(root);
    assert.deepEqual(await fs.readdir(root), []);

    const chartRoot = path.join(root, 'charts');
    const nav = path.join(chartRoot, '2026-09-03', 'nav');
    const packages = path.join(chartRoot, '2026-09-03', 'mbtiles');
    const terrain = path.join(chartRoot, 'terrain');
    await Promise.all([nav, packages, terrain].map(directory => fs.mkdir(directory, { recursive: true })));
    const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
    const contents = '{}\n';
    const file = `airports.${sha256(contents)}.json`;
    await fs.writeFile(path.join(nav, file), contents);
    await fs.writeFile(path.join(nav, 'manifest.json'), JSON.stringify({
        schemaVersion: 3, products: [{ id: 'airports', file, bytes: contents.length, sha256: sha256(contents) }]
    }));
    await fs.writeFile(path.join(packages, 'manifest.json'), JSON.stringify({ archives: [] }));
    const provenance = `${sha256(contents)}.terrain-sources.json`;
    await fs.writeFile(path.join(terrain, provenance), contents);
    await fs.writeFile(path.join(terrain, 'manifest.json'), JSON.stringify({
        provenance: { file: provenance, byteLength: contents.length, sha256: sha256(contents) }, shards: []
    }));

    await cleanGenerated(root);
    assert.deepEqual((await fs.readdir(nav)).sort(), [file, 'manifest.json'].sort());
    assert.deepEqual(await fs.readdir(packages), ['manifest.json']);
    assert.deepEqual((await fs.readdir(terrain)).sort(), [provenance, 'manifest.json'].sort());
    assert.equal(await fs.access(path.join(root, 'sources')).then(() => true, () => false), false);
});

test('source migration leaves conflicting old and new inputs untouched', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-source-conflict-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const cycle = '2026-09-03';
    const published = path.join(root, 'charts', cycle);
    const oldNav = path.join(published, 'nasr');
    const chartSources = path.join(root, 'sources', cycle, 'charts');
    const navSources = path.join(root, 'sources', cycle, 'nav');
    await Promise.all([oldNav, chartSources, navSources].map(directory => fs.mkdir(directory, { recursive: true })));
    const oldTiff = path.join(published, 'sectional.tif');
    const newTiff = path.join(chartSources, 'sectional.tif');
    const oldZip = path.join(oldNav, 'APT_CSV.zip');
    const newZip = path.join(navSources, 'APT_CSV.zip');
    await Promise.all([
        fs.writeFile(oldTiff, 'old TIFF'), fs.writeFile(newTiff, 'new TIFF'),
        fs.writeFile(oldZip, 'old ZIP'), fs.writeFile(newZip, 'new ZIP')
    ]);
    await assert.rejects(migrateChartSources(path.join(root, 'charts')), /Conflicting chart source/);
    await assert.rejects(migrateNavSources(root), /Conflicting navigation source/);
    assert.equal(await fs.readFile(oldTiff, 'utf8'), 'old TIFF');
    assert.equal(await fs.readFile(newTiff, 'utf8'), 'new TIFF');
    assert.equal(await fs.readFile(oldZip, 'utf8'), 'old ZIP');
    assert.equal(await fs.readFile(newZip, 'utf8'), 'new ZIP');
});

test('automatic PDF migration leaves already-relocated catalogs for normal build recovery', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-pdf-recovery-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const cycle = path.join(root, 'charts', '2026-09-03');
    const directory = path.join(cycle, 'cs');
    await fs.mkdir(directory, { recursive: true });
    const catalog = { schemaVersion: 3, builderVersion: 3, volumes: [{ id: 'SW', url: 'cs-sw.pdf',
        byteLength: 3, sha256: createHash('sha256').update('old').digest('hex') }] };
    await fs.writeFile(path.join(directory, 'cs-sw.pdf'), 'new');
    const file = path.join(directory, 'catalog.json');
    await fs.writeFile(file, JSON.stringify(catalog));
    await migratePdfBooks(root);
    // Even a genuine migration elsewhere must not turn startup into a full audit.
    await fs.writeFile(path.join(cycle, 'tpp-sw2.pdf'), 'legacy');
    await migratePdfBooks(root);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), catalog);
    await assert.rejects(cleanGenerated(root), /PDF book identity mismatch/);
});

test('PDF migration updates both catalogs before removing root-level books', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-pdf-layout-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const cycle = path.join(root, 'charts', '2026-09-03');
    const tpp = path.join(cycle, 'tpp');
    const cs = path.join(cycle, 'cs');
    await Promise.all([tpp, cs].map(directory => fs.mkdir(directory, { recursive: true })));
    const book = (file: string) => ({ url: `../${file}`, byteLength: file.length,
        sha256: createHash('sha256').update(file).digest('hex') });
    for (const file of ['tpp-sw2.pdf', 'cs-pac.pdf', 'cs-sw.pdf']) {
        await fs.writeFile(path.join(cycle, file), file);
    }
    const catalog = { schemaVersion: 1, builderVersion: 2, generatedAt: '2026-09-03T00:00:00.000Z',
        volumes: [{ id: 'SW2', ...book('tpp-sw2.pdf') }, { id: 'PC1', ...book('cs-pac.pdf') }] };
    const artifact = jsonArtifact('catalog.json', catalog);
    await fs.writeFile(path.join(tpp, artifact.file), `${JSON.stringify(catalog)}\n`);
    await fs.writeFile(path.join(tpp, 'manifest.json'), JSON.stringify({ schemaVersion: 2, ...artifact,
        volumes: catalog.volumes, generatedAt: catalog.generatedAt }));
    const supplements = { schemaVersion: 3, builderVersion: 3, generatedAt: catalog.generatedAt,
        sourceXml: { url: 'test', sha256: 'a'.repeat(64) }, volumes: [{ id: 'SW', ...book('cs-sw.pdf') }], airports: [] };
    await fs.writeFile(path.join(cs, 'catalog.json'), JSON.stringify(supplements));

    await cleanGenerated(root);
    await cleanGenerated(root);

    const manifest = JSON.parse(await fs.readFile(path.join(tpp, 'manifest.json'), 'utf8'));
    const movedCatalog = JSON.parse(await fs.readFile(path.join(tpp, manifest.file), 'utf8'));
    assert.deepEqual(movedCatalog.volumes.map((volume: { url: string }) => volume.url),
        ['tpp-sw2.pdf', '../cs/cs-pac.pdf']);
    assert.deepEqual(manifest.volumes, movedCatalog.volumes);
    assert.equal(manifest.sha256, jsonArtifact('catalog.json', movedCatalog).sha256);
    const movedSupplements = JSON.parse(await fs.readFile(path.join(cs, 'catalog.json'), 'utf8'));
    assert.equal(movedSupplements.volumes[0].url, 'cs-sw.pdf');
    for (const file of ['tpp-sw2.pdf', 'cs-pac.pdf', 'cs-sw.pdf']) {
        const folder = file.startsWith('tpp-') ? tpp : cs;
        assert.equal(await fs.readFile(path.join(folder, file), 'utf8'), file);
        await assert.rejects(fs.access(path.join(cycle, file)), /ENOENT/);
    }
});
