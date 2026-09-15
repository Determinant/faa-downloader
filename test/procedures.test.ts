import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildProcedureCatalog, selectDtppEdition } from '../build-procedures.ts';
import {
    discoverDtppEditions,
    pageIndexEntry,
    parseProcedureCatalog,
    parseVolumeEffectiveInterval,
    resolveVolumePageIndexes
} from '../lib/procedures.ts';

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<digital_tpp cycle="2609" from_edate="0901Z  09/03/26" to_edate="0901Z  10/01/26">
  <state_code ID="CA">
    <city_name ID="HAYWARD" volume="SW-2">
      <airport_name ID="HAYWARD EXEC" military="N" apt_ident="HWD" icao_ident="KHWD" alnum="5015">
        <record>
          <chartseq>10100</chartseq><chart_code>MIN</chart_code>
          <chart_name>TAKEOFF MINIMUMS</chart_name><useraction></useraction>
          <pdf_name>SW2TO.PDF</pdf_name><cn_flg>N</cn_flg><cnsection></cnsection>
          <cnpage></cnpage><bvsection>L</bvsection><bvpage></bvpage>
          <procuid></procuid><two_colored>N</two_colored><civil></civil>
          <faanfd18></faanfd18><copter></copter><amdtnum></amdtnum>
          <amdtdate></amdtdate>
        </record>
        <record>
          <chartseq>53525</chartseq><chart_code>IAP</chart_code>
          <chart_name>RNAV (GPS) RWY 28L</chart_name><useraction>C</useraction>
          <pdf_name>05015R28L.PDF</pdf_name><cn_flg>N</cn_flg><cnsection></cnsection>
          <cnpage></cnpage><bvsection></bvsection><bvpage>94</bvpage>
          <procuid>23139</procuid><two_colored>N</two_colored><civil>C</civil>
          <faanfd18></faanfd18><copter>N</copter><amdtnum>1E</amdtnum>
          <amdtdate>02/20/2025</amdtdate><future_field>kept</future_field>
        </record>
        <record>
          <chartseq>70000</chartseq><chart_code>NEW</chart_code>
          <chart_name>FUTURE PRODUCT</chart_name><useraction></useraction>
          <pdf_name>05015NEW.PDF</pdf_name><cn_flg>N</cn_flg><cnsection></cnsection>
          <cnpage></cnpage><bvsection></bvsection><bvpage>95</bvpage>
          <procuid>future</procuid><two_colored>N</two_colored><civil>C</civil>
          <faanfd18></faanfd18><copter></copter><amdtnum></amdtnum>
          <amdtdate></amdtdate>
        </record>
      </airport_name>
    </city_name>
  </state_code>
</digital_tpp>`;

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
            item('future chart', 10, 300, 50), item('95', 190, 9)
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
});

test('d-TPP edition discovery selects current or requested metadata', () => {
    const html = `
      <a href="/d-tpp/2608/xml_data/d-tpp_Metafile.xml">Aug 6&ndash;Sep 3, 2026</a>
      <a href="/d-tpp/2609/xml_data/d-tpp_Metafile.xml">Sep 3&ndash;Oct 1, 2026</a>
      <a href="/d-tpp/2610/xml_data/d-tpp_Metafile.xml">Oct 1&ndash;Oct 29, 2026</a>`;
    const baseUrl = 'https://aeronav.faa.gov/d-tpp/search/';
    assert.equal(discoverDtppEditions(html, baseUrl).length, 3);
    assert.deepEqual(selectDtppEdition(html, baseUrl, '2026-09-14'), {
        cycle: '2609',
        url: 'https://aeronav.faa.gov/d-tpp/2609/xml_data/d-tpp_Metafile.xml',
        effectiveDate: '2026-09-03',
        expirationDate: '2026-10-01'
    });
    assert.equal(
        selectDtppEdition(html, baseUrl, '2026-09-14', '2026-10-01').effectiveDate,
        '2026-10-01'
    );
});

test('electronic TPP cover dates define the usable volume interval', () => {
    assert.deepEqual(parseVolumeEffectiveInterval(
        'Effective: 0901Z 03 SEP 2026 to: 0901Z 29 OCT 2026'
    ), {
        effectiveDate: '2026-09-03',
        expirationDate: '2026-10-29'
    });
    assert.equal(parseVolumeEffectiveInterval('not a TPP cover'), null);
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
            path.join(root, 'charts', '2026-09-03', 'tpp', 'catalog.json'),
            'utf8'
        ));
        assert.equal(written.sourceXml.sha256.length, 64);
        assert.deepEqual(written.volumes, []);

        const outputDirectory = path.join(root, 'charts', '2026-09-03', 'tpp');
        await fs.rm(path.join(outputDirectory, 'manifest.json'));
        await buildProcedureCatalog({ output: root, sourceXml: xmlPath });
        await fs.access(path.join(outputDirectory, 'manifest.json'));
        if (process.platform !== 'win32') {
            assert.equal((await fs.stat(outputDirectory)).mode & 0o777, 0o755);
        }

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

test('network build rejects a catalog that disagrees with the selected edition', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-procedures-cycle-'));
    const originalFetch = globalThis.fetch;
    try {
        globalThis.fetch = async url => String(url).includes('/search/')
            ? new Response(
                '<a href="https://aeronav.faa.gov/d-tpp/2609/xml_data/' +
                'd-tpp_Metafile.xml">Sep 3&ndash;Oct 1, 2026</a>'
            )
            : new Response(XML.replace('cycle="2609"', 'cycle="2610"'));
        await assert.rejects(
            buildProcedureCatalog({ output: root, today: '2026-09-14' }),
            /selected cycle 2609, XML has 2610/
        );
    } finally {
        globalThis.fetch = originalFetch;
        await fs.rm(root, { recursive: true, force: true });
    }
});
