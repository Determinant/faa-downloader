import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildChartSupplements } from '../build-chart-supplements.ts';
import { parseSupplementIndex, supplementDateCode, supplementPageLabel } from '../lib/chart-supplements.ts';

const airport = (id: string, pdf: string) => `<airport><aptname>TEST AIRPORT</aptname><aptcity>TEST</aptcity>
<aptid>${id}</aptid><pages><pdf>${pdf}</pdf><pdf>sw_HWD_notices_03SEP2026.pdf</pdf></pages></airport>`;
const xml = (rows: string) => `<airports from_edate="0901Z 09/03/26" to_edate="0901Z 10/29/26">
<location state="CALIFORNIA">${rows}</location></airports>`;

test('uses FAA airport IDs and first directory pages; skips NAVAIDs and notice PDFs', () => {
    const index = parseSupplementIndex(xml(airport('HWD', 'sw_174_03SEP2026.pdf') + airport('', 'sw_174_03SEP2026.pdf')));
    assert.equal(index.effectiveDate, '2026-09-03');
    assert.equal(index.expirationDate, '2026-10-29');
    assert.deepEqual(index.airports, [{ faaId: 'HWD', name: 'TEST AIRPORT', city: 'TEST', state: 'CALIFORNIA',
        volumeId: 'SW', printedPage: '174' }]);
});

test('retains border-airport books and collapses repeated references to the same page', () => {
    const index = parseSupplementIndex(xml(airport('PUW', 'nw_123_03SEP2026.pdf') +
        airport('PUW', 'nw_123_03SEP2026.pdf') + airport('PUW', 'sw_456_03SEP2026.pdf')));
    assert.deepEqual(index.airports.map(a => a.volumeId), ['NW', 'SW']);
});

test('rejects malformed or mismatched metadata instead of guessing a page', () => {
    for (const input of [xml(airport('HWD', '../sw_174_03SEP2026.pdf')), xml(airport('HWD', 'sw_174_09JUL2026.pdf')),
        xml(airport('HWD', 'sw_HWD_notices_03SEP2026.pdf')), xml(''), '<other/>',
        xml(airport('HWD', 'sw_174_03SEP2026.pdf')).replace('10/29/26', '02/30/26')]) {
        assert.throws(() => parseSupplementIndex(input));
    }
    assert.equal(supplementDateCode('2026-09-03'), '03SEP2026');
    assert.throws(() => supplementDateCode('2026-02-30'));
});

test('reads printed page labels only from unambiguous outer headers', () => {
    const item = (text: string, x: number, y: number) => ({ text, x, y, width: 10 });
    assert.equal(supplementPageLabel([item('174', 33, 582), item('999', 80, 550)], 405, 612), '174');
    assert.equal(supplementPageLabel([item('175', 363, 582)], 405, 612), '175');
    assert.equal(supplementPageLabel([item('174', 33, 582), item('175', 363, 582)], 405, 612), undefined);
    assert.equal(supplementPageLabel([item('174', 150, 582), item('175', 33, 520)], 405, 612), undefined);
});

// Three small pages with real PDF outlines exercise indexing without FAA downloads.
function supplementPdf(label = '174'): string {
    const page = (contents: number) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 405 612]
        /Resources << /Font << /F1 6 0 R >> >> /Contents ${contents} 0 R >>`;
    const stream = (text: string) => `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}endstream`;
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R /Outlines 10 0 R >>',
        '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>',
        page(7), page(8), page(9),
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        stream('BT /F1 7 Tf 30 500 Td (Effective: 0901Z 03 SEP 2026 to: 0901Z 29 OCT 2026) Tj ET\n'),
        stream(`BT /F1 10 Tf 33 582 Td (${label}) Tj ET\n`),
        stream('BT /F1 10 Tf 30 300 Td (Other section) Tj ET\n'),
        '<< /Type /Outlines /First 11 0 R /Last 12 0 R /Count 2 >>',
        '<< /Title (SECTION 2: DIRECTORY) /Parent 10 0 R /Next 12 0 R /Dest [4 0 R /Fit] >>',
        '<< /Title (SECTION 3: OTHER) /Parent 10 0 R /Prev 11 0 R /Dest [5 0 R /Fit] >>'
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    for (const [index, object] of objects.entries()) {
        offsets.push(Buffer.byteLength(pdf));
        pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    }
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
    for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
    return `${pdf}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

async function supplementFixture(t: import('node:test').TestContext) {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-supplements-'));
    t.after(() => fs.rm(output, { recursive: true, force: true }));
    const effectiveDate = '2026-09-03';
    const directory = path.join(output, 'charts', effectiveDate);
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, 'cs-sw.pdf');
    const sourceXml = path.join(output, 'afd.xml');
    await fs.writeFile(file, supplementPdf());
    await fs.writeFile(sourceXml, xml(airport('HWD', 'sw_174_03SEP2026.pdf')));
    return { output, effectiveDate, sourceXml, file, directory,
        catalogFile: path.join(directory, 'cs', 'catalog.json') };
}

test('unchanged CS books and XML reuse the verified catalog; force rebuilds it', async t => {
    const f = await supplementFixture(t);
    const catalog = await buildChartSupplements(f);
    assert.equal(catalog.airports[0].pageIndex, 1);
    await fs.utimes(f.catalogFile, 1, 1);
    assert.deepEqual(await buildChartSupplements(f), catalog);
    assert.equal((await fs.stat(f.catalogFile)).mtimeMs, 1000);
    await buildChartSupplements({ ...f, force: true });
    assert.notEqual((await fs.stat(f.catalogFile)).mtimeMs, 1000);

    // Catalog integrity is verified as well as source identity.
    await fs.writeFile(f.catalogFile, JSON.stringify({ ...catalog, airports: [] }));
    assert.equal((await buildChartSupplements(f)).airports.length, 1);
    await fs.rm(f.catalogFile);
    assert.equal((await buildChartSupplements(f)).airports[0].pageIndex, 1);
});

test('CS reuse invalidates changed XML, same-size PDF edits, and the available book set', async t => {
    const f = await supplementFixture(t);
    const original = await buildChartSupplements(f);
    await fs.writeFile(f.sourceXml, xml(airport('SQL', 'sw_174_03SEP2026.pdf')));
    const changed = await buildChartSupplements(f);
    assert.equal(changed.airports[0].faaId, 'SQL');
    assert.notEqual(changed.sourceXml.sha256, original.sourceXml.sha256);

    const size = (await fs.stat(f.file)).size;
    await fs.writeFile(f.file, supplementPdf('175'));
    assert.equal((await fs.stat(f.file)).size, size);
    await assert.rejects(buildChartSupplements(f), /missing page 174/);
    assert.deepEqual(JSON.parse(await fs.readFile(f.catalogFile, 'utf8')), changed,
        'failed reindexing retains the published catalog');
    await fs.writeFile(f.sourceXml, xml(airport('SQL', 'sw_175_03SEP2026.pdf') + airport('PUW', 'nw_175_03SEP2026.pdf')));
    const partial = await buildChartSupplements(f);
    assert.equal(partial.volumes.length, 1);
    const northwest = path.join(f.directory, 'cs-nw.pdf');
    await fs.copyFile(f.file, northwest);
    const expanded = await buildChartSupplements(f);
    assert.equal(expanded.volumes.length, 2);
    assert.deepEqual(expanded.airports.map(airport => airport.faaId), ['PUW', 'SQL']);
    await fs.rm(northwest);
    assert.equal((await buildChartSupplements(f)).volumes.length, 1);
});
