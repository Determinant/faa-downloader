import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildProcedureCatalog, prepareProcedureCatalog } from '../build-procedures.ts';
import { faaEffectiveDate } from '../lib/faa-effective-date.ts';
import { acquireChartBuildLock } from '../lib/chart-build-lock.ts';
import { sha256File } from '../lib/fs-utils.ts';
import {
    pageIndexEntry,
    parseProcedureCatalog,
    parseVolumeEffectiveInterval,
    resolveVolumePageIndexes
} from '../lib/procedures.ts';

const XML = (await fs.readFile(new URL('./fixtures/procedure-catalog.xml', import.meta.url), 'utf8')).trimEnd();

test('d-TPP parser preserves complete records and normalized targets', () => {
    const catalog = parseProcedureCatalog(XML, 'https://example.test/metafile.xml', 'abc', 'now');
    assert.equal(catalog.cycle, '2609');
    assert.equal(catalog.effectiveDate, '2026-09-03');
    assert.equal(catalog.expirationDate, '2026-10-01');
    assert.equal(catalog.airports.length, 1);

    const airport = catalog.airports[0];
    assert.equal(airport.id, 'KHWD');
    assert.equal(airport.volumeId, 'SW2');
    assert.deepEqual(airport.procedures.map(procedure => procedure.kind), [
        'takeoff-minimums', 'approach', 'other'
    ]);
    assert.equal(airport.procedures[0].namedDestination, '(HWD)');
    assert.equal(
        airport.procedures[1].pdfUrl,
        'https://aeronav.faa.gov/d-tpp/2609/05015R28L.PDF'
    );
    assert.deepEqual(airport.procedures[1].source.extraFields, { future_field: 'kept' });
    assert.equal(new Set(airport.procedures.map(procedure => procedure.id)).size, 3);
});

test('volume page resolver distinguishes printed pages from PDF page indexes', () => {
    const catalog = parseProcedureCatalog(XML, 'test', 'abc', 'now');
    const item = (text: string, x: number, y: number, width = 8) => ({ text, x, y, width });
    const pages = [
        pageIndexEntry(1, [
            item('Contents', 10, 570), item('Z1', 20, 300), item('L13', 188, 300)
        ], 387, 594),
        pageIndexEntry(42, [
            item('L', 188, 580, 4), item('13', 192, 580, 7),
            item('TAKEOFF MINS', 10, 540, 40), item('HAYWARD EXEC (HWD)', 10, 300, 80),
            item('L', 188, 14, 4), item('13', 192, 14, 7)
        ], 387, 594),
        pageIndexEntry(219, [
            item('approach chart', 10, 300, 50), item('94', 190, 580)
        ], 387, 594),
        pageIndexEntry(220, [
            item('future chart', 10, 300, 50), item('95', 190, 9),
            // A chart-minimums fraction near the footer is not another page label.
            item('94', 196, 34, 3)
        ], 387, 594)
    ];

    assert.deepEqual(resolveVolumePageIndexes(catalog, 'SW2', pages), {
        resolved: 3,
        unresolved: 0
    });
    assert.deepEqual(
        catalog.airports[0].procedures.map(procedure => procedure.volumeTarget?.pageIndex),
        [42, 219, 220]
    );
    assert.deepEqual(pages[0].pageLabels, []);
    assert.deepEqual(pages[1].pageLabels, ['L13']);
    assert.deepEqual(pages[3].pageLabels, ['95']);
});

test('d-TPP parser excludes deleted procedures and stale deletion placeholders', () => {
    for (const [action, filename] of [
        ['D', 'SW2TO.PDF'],
        ['D', 'DELETED_JOB.PDF'],
        ['', 'DELETED_JOB.PDF'],
        ['', 'DEL_APT_SERVED.PDF']
    ]) {
        const xml = XML
            .replace('<useraction></useraction>', `<useraction>${action}</useraction>`)
            .replace('SW2TO.PDF', filename);
        const catalog = parseProcedureCatalog(xml, 'test', 'abc', 'now');
        assert.deepEqual(catalog.airports[0].procedures.map(procedure => procedure.name), [
            'RNAV (GPS) RWY 28L', 'FUTURE PRODUCT'
        ], `${action}: ${filename}`);
        assert.deepEqual(resolveVolumePageIndexes(catalog, 'SW2', [
            { pageIndex: 219, text: 'approach chart', pageLabels: ['94'] },
            { pageIndex: 220, text: 'future chart', pageLabels: ['95'] }
        ]), { resolved: 2, unresolved: 0 });
    }
});

test('change-notice pages and sections take precedence over the regional book', () => {
    const xml = XML
        .replace('<cnsection></cnsection>', '<cnsection>C</cnsection>')
        .replace('<cnpage></cnpage><bvsection></bvsection><bvpage>94</bvpage>',
            '<cnpage>22</cnpage><bvsection></bvsection><bvpage>94</bvpage>');
    const catalog = parseProcedureCatalog(xml, 'test', 'abc');
    const procedures = catalog.airports[0].procedures;
    assert.equal(catalog.airports[0].volumeId, 'SW2');
    assert.deepEqual(procedures.map(p => p.volumeTarget?.volumeId), ['CN', 'CN', 'SW2']);
    assert.deepEqual(resolveVolumePageIndexes(catalog, 'SW2', [
        { pageIndex: 3, text: 'outdated approach', pageLabels: ['94'] },
        { pageIndex: 4, text: 'unchanged chart', pageLabels: ['95'] }
    ]), { resolved: 1, unresolved: 0 });
    assert.equal(procedures[1].volumeTarget?.pageIndex, null);
    assert.deepEqual(resolveVolumePageIndexes(catalog, 'CN', [
        { pageIndex: 7, text: 'HAYWARD EXEC (KHWD/HWD)', pageLabels: ['C1'] },
        { pageIndex: 31, text: 'updated approach', pageLabels: ['22'] }
    ]), { resolved: 2, unresolved: 0 });
    assert.deepEqual(procedures.map(p => p.volumeTarget?.pageIndex), [7, 31, 4]);
    // A flag without CN page/section metadata on a major cycle keeps its base target.
    const base = parseProcedureCatalog(XML.replaceAll('<cn_flg>N</cn_flg>', '<cn_flg>Y</cn_flg>'), 'test', 'abc');
    assert.ok(base.airports[0].procedures.every(p => p.volumeTarget?.volumeId === 'SW2'));
});

test('procedure builds index the current notice, include newly added plates, and reject unresolved replacements', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-procedures-notice-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network access'); });
    const previous = path.join(root, 'charts', '2026-09-03', 'tpp');
    const current = path.join(root, 'charts', '2026-10-01', 'tpp');
    await fs.mkdir(previous, { recursive: true });
    await fs.mkdir(current, { recursive: true });
    const fixture = new URL('./fixtures/procedure-volume.pdf', import.meta.url);
    await fs.copyFile(fixture, path.join(previous, 'tpp-sw2.pdf'));
    await fs.copyFile(fixture, path.join(previous, 'tpp-cn.pdf'));
    const sourceXml = path.join(root, 'metafile.xml');
    const xml = XML.replace('cycle="2609"', 'cycle="2610"')
        .replace('from_edate="0901Z  09/03/26" to_edate="0901Z  10/01/26"',
            'from_edate="0901Z  10/01/26" to_edate="0901Z  10/29/26"')
        .replace('<cnpage></cnpage><bvsection></bvsection><bvpage>94</bvpage>',
            '<cnpage>94</cnpage><bvsection></bvsection><bvpage>94</bvpage>')
        .replace('<cnpage></cnpage><bvsection></bvsection><bvpage>95</bvpage>',
            '<cnpage>95</cnpage><bvsection></bvsection><bvpage></bvpage>');
    await fs.writeFile(sourceXml, xml);
    const options = { output: root, sourceXml };
    const partial = await buildProcedureCatalog(options);
    assert.deepEqual(partial.volumes.map(v => v.id), ['SW2'], 'previous notice must not be reused');
    assert.deepEqual(partial.airports[0].procedures.map(p => p.volumeTarget?.pageIndex), [0, null, null]);
    await fs.copyFile(fixture, path.join(current, 'tpp-cn.pdf'));
    const complete = await buildProcedureCatalog(options);
    assert.deepEqual(complete.volumes.map(v => [v.id, v.resolvedTargetCount]), [['CN', 2], ['SW2', 1]]);
    for (const volume of complete.volumes) assert.equal(volume.url,
        `${volume.id === 'CN' ? '' : '../../2026-09-03/tpp/'}tpp-${volume.id.toLowerCase()}.${volume.sha256}.pdf`);
    assert.deepEqual(complete.airports[0].procedures.map(p => p.volumeTarget?.pageIndex), [0, 1, 2]);
    assert.equal((await buildProcedureCatalog(options)).generatedAt, complete.generatedAt);
    await fs.access(path.join(current, 'tpp-cn.pdf'));
    const manifestFile = path.join(current, 'manifest.json');
    const manifest = await fs.readFile(manifestFile, 'utf8');
    await fs.writeFile(sourceXml, xml.replace('<cnpage>94</cnpage>', '<cnpage>999</cnpage>'));
    await assert.rejects(buildProcedureCatalog(options), /CN: 1 PDF page targets could not be resolved/);
    assert.equal(await fs.readFile(manifestFile, 'utf8'), manifest);
});

test('Pacific page labels come from terminal headers, not other supplement sections', () => {
    for (const x of [33, 363]) {
        const label = { text: '94', x, y: 582, width: 9 };
        assert.deepEqual(pageIndexEntry(200, [
            { text: 'TERMINAL PROCEDURES', x: 164, y: 582, width: 86 },
            label,
            { text: '2', x: 200, y: 47, width: 3 }
        ], 405, 612).pageLabels, ['94']);
        assert.deepEqual(pageIndexEntry(20, [
            { text: 'AIRPORT DIRECTORY', x: 164, y: 582, width: 86 }, label
        ], 405, 612).pageLabels, []);
        assert.deepEqual(pageIndexEntry(148, [
            { text: 'TERMINAL PROCEDURES', x: 164, y: 582, width: 86 }, label,
            { text: 'Table of Contents', x: 50, y: 500, width: 100 }
        ], 405, 612).pageLabels, []);
    }
});

test('section targets recognize slash-separated FAA and ICAO identifiers', () => {
    for (const ids of ['KHWD/HWD', 'HWD/KHWD']) {
        const catalog = parseProcedureCatalog(XML, 'test', 'abc', 'now');
        resolveVolumePageIndexes(catalog, 'SW2', [
            { pageIndex: 41, text: 'OTHER (XHWD/HWDX)', pageLabels: ['L12'] },
            { pageIndex: 42, text: `HAYWARD EXEC (${ids})`, pageLabels: ['L13'] }
        ]);
        assert.equal(catalog.airports[0].procedures[0].volumeTarget?.pageIndex, 42);
    }
});

test('section targets accept military K-prefixed identifiers missing from the XML', () => {
    const xml = XML.replace('military="N"', 'military="M"')
        .replace('apt_ident="HWD" icao_ident="KHWD"', 'apt_ident="W94" icao_ident=""');
    const catalog = parseProcedureCatalog(xml, 'test', 'abc', 'now');
    assert.deepEqual(resolveVolumePageIndexes(catalog, 'SW2', [
        { pageIndex: 39, text: 'Another airport (XW94)', pageLabels: ['L6'] },
        { pageIndex: 40, text: 'CAMP PEARY LNDG STRIP (KW94)', pageLabels: ['L7'] }
    ]), { resolved: 1, unresolved: 2 });
    assert.equal(catalog.airports[0].procedures[0].volumeTarget?.pageIndex, 40);
    assert.equal(catalog.airports[0].procedures[1].volumeTarget?.pageIndex, null);
});

test('electronic TPP cover dates define the usable volume interval', () => {
    assert.deepEqual(parseVolumeEffectiveInterval(
        'Effective: 0901Z 03 SEP 2026 to: 0901Z 29 OCT 2026'
    ), {
        effectiveDate: '2026-09-03',
        expirationDate: '2026-10-29'
    });
    assert.equal(parseVolumeEffectiveInterval('not a TPP cover'), null);
    assert.deepEqual(parseVolumeEffectiveInterval(
        'CHART SUPPLEMENT PACIFIC Effective 0901Z 3 SEP 2026 to 0901Z 29 OCT 2026'
    ), {
        effectiveDate: '2026-09-03',
        expirationDate: '2026-10-29'
    });
});

test('d-TPP parser rejects unsafe PDF paths', () => {
    assert.throws(
        () => parseProcedureCatalog(XML.replace('SW2TO.PDF', '../SW2TO.PDF'), 'test', 'abc'),
        /Unsafe d-TPP PDF filename/
    );
});

test('procedure kinds cover FAA departure and arrival codes', () => {
    const kindFor = (chartCode: string) => parseProcedureCatalog(
        XML.replace('<chart_code>NEW</chart_code>', `<chart_code>${chartCode}</chart_code>`),
        'test',
        'abc'
    ).airports[0].procedures.find(procedure => procedure.name === 'FUTURE PRODUCT')?.kind;

    for (const chartCode of ['DP', 'ODP']) assert.equal(kindFor(chartCode), 'departure');
    for (const chartCode of ['STR', 'STAR']) assert.equal(kindFor(chartCode), 'arrival');
});

test('local procedure build does not access the network', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-procedures-'));
    const xmlPath = path.join(root, 'metafile.xml');
    const originalFetch = globalThis.fetch;
    try {
        await fs.writeFile(xmlPath, XML);
        globalThis.fetch = async () => {
            throw new Error('unexpected network access');
        };
        const catalog = await buildProcedureCatalog({ output: root, sourceXml: xmlPath });
        assert.equal(catalog.airports.length, 1);
        const written = JSON.parse(await fs.readFile(
            path.join(root, 'charts', '2026-09-03', 'tpp', JSON.parse(await fs.readFile(path.join(root, 'charts', '2026-09-03', 'tpp', 'manifest.json'), 'utf8')).file),
            'utf8'
        ));
        assert.equal(written.sourceXml.sha256.length, 64);
        assert.deepEqual(written.volumes, []);

        await fs.writeFile(xmlPath, `\uFEFF${XML}`);
        assert.equal((await buildProcedureCatalog({ output: root, sourceXml: xmlPath })).sourceXml.sha256, written.sourceXml.sha256,
            'local BOM decoding must agree with online Response.text decoding');

        const outputDirectory = path.join(root, 'charts', '2026-09-03', 'tpp');
        await fs.rm(path.join(outputDirectory, 'manifest.json'));
        await buildProcedureCatalog({ output: root, sourceXml: xmlPath });
        await fs.access(path.join(outputDirectory, 'manifest.json'));
        if (process.platform !== 'win32') {
            assert.equal((await fs.stat(outputDirectory)).mode & 0o777, 0o755);
        }

        await fs.rm(path.join(outputDirectory, 'manifest.json'));
        await fs.writeFile(
            path.join(outputDirectory, 'catalog.json'),
            '{"schemaVersion":1,"airports":[],"volumes":[]}\n'
        );
        const rebuilt = await buildProcedureCatalog({ output: root, sourceXml: xmlPath });
        assert.equal(rebuilt.airports.length, 1);
    } finally {
        globalThis.fetch = originalFetch;
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('procedure publication rejects a concurrent builder for the same cycle', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-procedures-lock-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const xmlPath = path.join(root, 'metafile.xml');
    const cycle = path.join(root, 'charts', '2026-09-03');
    await fs.mkdir(cycle, { recursive: true });
    await fs.writeFile(xmlPath, XML);
    const release = await acquireChartBuildLock(path.join(cycle, '.tpp'));
    try {
        await assert.rejects(buildProcedureCatalog({ output: root, sourceXml: xmlPath }),
            /Chart build already in progress/);
    } finally { await release(); }
});

test('procedure builds index Alaska and Pacific filenames and refresh older catalogs', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-procedures-volumes-'));
    try {
        for (const [volumeId, filename] of [['AK1', 'tpp-ak.pdf'], ['PC1', 'cs-pac.pdf']]) {
            const output = path.join(root, volumeId);
            const cycleDirectory = path.join(output, 'charts', '2026-09-03');
            const sourceXml = path.join(output, 'metafile.xml');
            const bookDirectory = path.join(cycleDirectory, filename.startsWith('tpp-') ? 'tpp' : 'cs');
            await fs.mkdir(bookDirectory, { recursive: true });
            await fs.writeFile(sourceXml, XML.replace('volume="SW-2"', `volume="${volumeId}"`));
            await fs.copyFile(new URL('./fixtures/procedure-volume.pdf', import.meta.url),
                path.join(bookDirectory, filename));

            const catalog = await buildProcedureCatalog({ output, sourceXml });
            assert.equal(catalog.volumes.length, 1);
            assert.equal(catalog.volumes[0].id, volumeId);
            const digest = await sha256File(path.join(bookDirectory, filename));
            const publishedName = filename.replace(/\.pdf$/, `.${digest}.pdf`);
            assert.equal(catalog.volumes[0].url, filename.startsWith('tpp-') ? publishedName : `../cs/${publishedName}`);
            assert.equal(await sha256File(path.resolve(cycleDirectory, 'tpp', catalog.volumes[0].url)), digest);
            assert.equal(catalog.volumes[0].resolvedTargetCount, 3);
            assert.deepEqual(catalog.airports[0].procedures.map(p => p.volumeTarget?.pageIndex),
                [0, 1, 2]);
            const current = await buildProcedureCatalog({ output, sourceXml });
            assert.equal(current.generatedAt, catalog.generatedAt);

            const manifestPath = path.join(cycleDirectory, 'tpp', 'manifest.json');
            // A path-only migration reuses verified page indexes and republishes book URLs.
            await fs.rm(manifestPath);
            await fs.writeFile(path.join(cycleDirectory, 'tpp', 'catalog.json'), JSON.stringify({
                ...catalog, volumes: catalog.volumes.map(volume => ({ ...volume, url: `../${filename}` }))
            }));
            const relocated = await buildProcedureCatalog({ output, sourceXml });
            assert.equal(relocated.volumes[0].url, catalog.volumes[0].url);
            assert.deepEqual(relocated.airports[0].procedures.map(p => p.volumeTarget?.pageIndex), [0, 1, 2]);

            // Old unversioned catalogs are rebuilt into immutable generations.
            await fs.rm(manifestPath);
            await fs.writeFile(path.join(cycleDirectory, 'tpp', 'catalog.json'), JSON.stringify({ ...catalog, builderVersion: 1 }));
            const rebuilt = await buildProcedureCatalog({ output, sourceXml });
            assert.equal(rebuilt.builderVersion, catalog.builderVersion);

            // A missing active target must fail without replacing the published catalog.
            const catalogPath = path.join(cycleDirectory, 'tpp', JSON.parse(await fs.readFile(manifestPath, 'utf8')).file);
            const previous = await fs.readFile(catalogPath, 'utf8');
            const previousManifest = await fs.readFile(manifestPath, 'utf8');
            await fs.writeFile(sourceXml, XML.replace('volume="SW-2"', `volume="${volumeId}"`)
                .replace('<bvpage>94</bvpage>', '<bvpage>999</bvpage>'));
            await assert.rejects(buildProcedureCatalog({ output, sourceXml }),
                /KHWD: RNAV \(GPS\) RWY 28L \(05015R28L\.PDF\)/);
            assert.equal(await fs.readFile(catalogPath, 'utf8'), previous);
            assert.equal(await fs.readFile(manifestPath, 'utf8'), previousManifest);
        }
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

const xmlUrl = (cycle: string) => `https://aeronav.faa.gov/d-tpp/${cycle}/xml_data/d-tpp_Metafile.xml`;
const nextXml = XML.replace('cycle="2609"', 'cycle="2610"')
    .replace('09/03/26', '10/01/26').replace('to_edate="0901Z  10/01/26"', 'to_edate="0901Z  10/29/26"');

test('online d-TPP builds honor 0901Z and explicit editions without the search page', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-procedures-dates-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const requests: string[] = [];
    t.mock.method(globalThis, 'fetch', async input => {
        const url = String(input);
        requests.push(url);
        if (url === xmlUrl('2609')) return new Response(XML);
        if (url === xmlUrl('2610')) return new Response(nextXml);
        throw new Error(`Unexpected request: ${url}`);
    });
    for (const [instant, cycle] of [
        ['2026-10-01T00:00:00Z', '2609'],
        ['2026-10-01T09:00:59.999Z', '2609'],
        ['2026-10-01T09:01:00Z', '2610']
    ]) {
        const catalog = await buildProcedureCatalog({ output: root, today: faaEffectiveDate(new Date(instant)) });
        assert.equal(catalog.cycle, cycle);
        assert.equal(catalog.sourceXml.url, xmlUrl(cycle));
    }
    // Explicit editions work even after their listing disappears or before they take effect.
    assert.equal((await buildProcedureCatalog({ output: root, today: '2026-10-01', effectiveDate: '2026-09-03' })).cycle, '2609');
    assert.equal((await buildProcedureCatalog({ output: root, today: '2026-09-30', effectiveDate: '2026-10-01' })).cycle, '2610');
    assert.deepEqual(requests, ['2609', '2609', '2610', '2609', '2610'].map(xmlUrl));
    for (const effectiveDate of ['2026-09-30', '2026-02-30', 'not-a-date']) {
        await assert.rejects(prepareProcedureCatalog({ output: root, effectiveDate }), /AIRAC/);
    }
    assert.equal(requests.length, 5, 'invalid edition dates fail before any request');
});

test('prepared d-TPP input survives rollover and reads books only at publication', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-procedures-prepared-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-01T09:00:59Z') });
    const fetch = t.mock.method(globalThis, 'fetch', async input => {
        assert.equal(String(input), xmlUrl('2609'));
        return new Response(XML);
    });
    const prepared = await prepareProcedureCatalog({ output: root });
    assert.equal(prepared.effectiveDate, '2026-09-03');
    await assert.rejects(fs.access(path.join(root, 'charts')), { code: 'ENOENT' });

    // A long download crosses the boundary; neither the clock nor a changed source
    // cache may change the validated input captured at startup.
    t.mock.timers.setTime(new Date('2026-10-01T10:00:00Z').getTime());
    await fs.writeFile(path.join(root, 'sources/2026-09-03/tpp/d-tpp_Metafile.xml'), nextXml);
    const directory = path.join(root, 'charts/2026-09-03/tpp');
    await fs.mkdir(directory, { recursive: true });
    await fs.copyFile(new URL('./fixtures/procedure-volume.pdf', import.meta.url), path.join(directory, 'tpp-sw2.pdf'));
    const catalog = await prepared.build();
    assert.equal(catalog.cycle, '2609');
    assert.deepEqual(catalog.airports[0].procedures.map(p => p.volumeTarget?.pageIndex), [0, 1, 2]);
    assert.equal(catalog.generatedAt, '2026-10-01T10:00:00.000Z');
    assert.deepEqual(await prepared.build(), catalog, 'a retry does not accumulate mutable page indexes or volumes');
    assert.equal(fetch.mock.callCount(), 1, 'publication never re-fetches XML');
});

test('d-TPP corrections are revalidated and invalid inputs preserve the previous publication', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-procedures-revalidate-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const options = { output: root, today: '2026-09-30' };
    let body = XML, status = 200, etag = '"first"';
    const headers: Headers[] = [];
    t.mock.method(globalThis, 'fetch', async (input, init) => {
        assert.equal(String(input), xmlUrl('2609'));
        headers.push(new Headers(init?.headers));
        return new Response(status === 304 ? null : body, { status, headers: { etag } });
    });
    const first = await buildProcedureCatalog(options);
    status = 304;
    assert.deepEqual(await buildProcedureCatalog(options), first);
    assert.equal(headers[1].get('if-none-match'), '"first"');
    body = XML.replace('FUTURE PRODUCT', 'CORRECTED PRODUCT'); status = 200; etag = '"corrected"';
    const corrected = await buildProcedureCatalog(options);
    assert.notEqual(corrected.sourceXml.sha256, first.sourceXml.sha256);
    const manifest = path.join(root, 'charts/2026-09-03/tpp/manifest.json');
    const previous = await fs.readFile(manifest, 'utf8');
    const source = path.join(root, 'sources/2026-09-03/tpp/d-tpp_Metafile.xml');
    const previousSource = await fs.readFile(source, 'utf8');
    for (const invalid of [
        XML.replace('cycle="2609"', 'cycle="2610"'),
        XML.replace('09/03/26', '09/04/26'),
        XML.replace('10/01/26', '10/29/26'),
        XML.replace('0901Z', '0000Z'),
        nextXml,
        '<html>Service unavailable</html>',
        XML.slice(0, XML.indexOf('<state_code')) + '</digital_tpp>'
    ]) {
        body = invalid;
        await assert.rejects(prepareProcedureCatalog(options), /d-TPP/);
        assert.equal(await fs.readFile(manifest, 'utf8'), previous);
        assert.equal(await fs.readFile(source, 'utf8'), previousSource);
        await assert.rejects(fs.access(`${source}.part`), { code: 'ENOENT' });
    }
    status = 404;
    await assert.rejects(prepareProcedureCatalog(options), /404.*2609/);
    assert.equal(await fs.readFile(manifest, 'utf8'), previous);
    assert.equal(await fs.readFile(source, 'utf8'), previousSource);
    await assert.rejects(fs.access(path.join(root, 'sources/2026-09-03/tpp.build.lock')), { code: 'ENOENT' });
});

test('d-TPP preflight retries transient server failures for the same edition', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-procedures-retry-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    let attempts = 0;
    t.mock.method(globalThis, 'fetch', async input => {
        assert.equal(String(input), xmlUrl('2609'));
        return ++attempts === 1 ? new Response('Unavailable', { status: 503 }) : new Response(XML);
    });
    assert.equal((await prepareProcedureCatalog({ output: root, today: '2026-09-30' })).effectiveDate, '2026-09-03');
    assert.equal(attempts, 2);
});
