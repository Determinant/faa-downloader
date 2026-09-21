import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { acquireCifp } from '../lib/cifp-source.ts';
import { parseCifpProcedures } from '../lib/cifp.ts';
import { buildTerminalBundle } from '../lib/terminal-bundle.ts';
import { buildTerminalProcedures } from '../lib/terminal-procedures.ts';

const raw = await fs.readFile(new URL('./fixtures/terminal-cifp.txt', import.meta.url), 'utf8');
const topology = JSON.parse(await fs.readFile(new URL('./fixtures/terminal-procedures.json', import.meta.url), 'utf8'));
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const source = { group: 'CIFP' as const, filename: 'FAACIFP18', url: 'https://example.test/FAACIFP18', sha256: hash(raw),
    recordFile: { filename: 'FAACIFP18' as const, bytes: Buffer.byteLength(raw), sha256: hash(raw) } };
const lines = raw.trimEnd().split('\n');
const build = (input = raw) => buildTerminalBundle(topology, input, '2026-09-03', { ...source,
    sha256: hash(input), recordFile: { ...source.recordFile, bytes: Buffer.byteLength(input), sha256: hash(input) } });

test('one bundle accounts for real approach, SID and STAR legs with separate source identities', () => {
    const data = build();
    assert.deepEqual(data.coverage.sourceLegs, data.coverage.exportedLegs);
    assert.equal(data.coverage.departures, 1);
    assert.equal(data.coverage.arrivals, 1);
    assert.equal(data.coverage.codedDepartures, 1);
    assert.equal(data.coverage.codedArrivals, 1);
    const ils = data.approaches.procedures.find(p => p.id === 'KVGT:I12L')!;
    assert.equal(ils.final[0].fix!.ident, 'JOKUS');
    assert.equal(ils.final[1].fix!.ident, 'KIGGE');
    assert.equal(ils.final.at(-1)!.fix!.ident, 'LAS');
    assert.equal(ils.final.at(-1)!.missed, true);
    const sid = data.codedProcedures.procedures.find(p => p.id === 'KSJC:departure:SPTNS1')!;
    const star = data.codedProcedures.procedures.find(p => p.id === 'KSNA:arrival:OHSEA3')!;
    assert.ok(sid.branches.some(b => b.transition === 'RW30L'));
    assert.ok(star.branches.some(b => b.transition === 'ELLBC'));
    assert.ok(sid.branches.flatMap(b => b.legs).some(l => l.altitude));
    assert.ok([...sid.branches, ...star.branches].flatMap(b => b.legs).every(l => !l.missed && !l.fix?.role));
    assert.deepEqual(data.sources, [source]);
});

test('an incomplete procedure family cannot become a successful terminal bundle', () => {
    for (const section of ['D', 'E', 'F']) {
        const partial = lines.filter(line => !(line[4] === 'P' && line[12] === section)).join('\n');
        assert.throws(() => build(partial), /CIFP contains no .* records/);
    }
    assert.throws(() => buildTerminalBundle({ ...topology,
        departureRoutes: topology.departureRoutes.split('\n')[0] + '\n',
        departureAirports: topology.departureAirports.split('\n')[0] + '\n'
    }, raw, '2026-09-03', source), /no departure route topology/);
});

test('duplicate primary legs, orphan continuations and malformed numeric fields fail for every family', () => {
    for (const section of ['D', 'E', 'F']) {
        const line = lines.find(line => line[4] === 'P' && line[12] === section && line[38] === '0')!;
        assert.throws(() => build(raw + line + '\n'), /Duplicate CIFP procedure sequence/);
        const malformed = line.slice(0, 70) + '12x0' + line.slice(74);
        assert.throws(() => build(raw.replace(line, malformed)), /Invalid CIFP numeric field/);
    }
    const continuation = lines.find(line => line[4] === 'P' && line[12] === 'F' && line[38] === '2')!;
    assert.ok(continuation);
    const orphan = continuation.slice(0, 13) + 'I99   ' + continuation.slice(19);
    assert.throws(() => build(raw.replace(continuation, orphan)), /Orphan CIFP continuation/);
});

test('unresolved fix identities survive export and ambiguous definitions do not depend on record order', () => {
    const fix = lines.find(line => line[6] === 'K' && line.slice(6, 10) === 'KVGT' && line[12] === 'C' && line.slice(13, 18) === 'JOKUS')!;
    assert.ok(fix);
    const conflict = fix.slice(0, 32) + 'N35000000W115000000' + fix.slice(51);
    for (const input of [raw.replace(fix, ''), raw + conflict + '\n', raw.replace(fix, conflict + '\n' + fix)]) {
        const data = build(input);
        const first = data.approaches.procedures.find(p => p.id === 'KVGT:I12L')!.final[0];
        assert.equal(first.fix, undefined);
        assert.equal(first.sourceFix!.ident, 'JOKUS');
        assert.ok(data.diagnostics.cifp.some(d => d.procedureId === 'KVGT:I12L' && d.code === 'unresolved-fix'));
    }
});

test('local extracted and ZIP inputs are equivalent, require CIFP, and remain offline', async t => {
    t.mock.method(globalThis, 'fetch', () => { throw new Error('Offline build attempted a download'); });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'terminal-source-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const cache = path.join(root, 'cache');
    await assert.rejects(acquireCifp('2026-09-03', cache, root), /CIFP is required/);
    await fs.writeFile(path.join(root, 'FAACIFP18'), raw);
    const extracted = await acquireCifp('2026-09-03', cache, root);
    assert.equal(extracted.source.recordFile.sha256, hash(raw));
    await promisify(execFile)('zip', ['-q', 'CIFP_260903.zip', 'FAACIFP18'], { cwd: root });
    await fs.rm(path.join(root, 'FAACIFP18'));
    const archived = await acquireCifp('2026-09-03', cache, root);
    assert.equal(archived.text, extracted.text);
    assert.deepEqual(archived.source.recordFile, extracted.source.recordFile);
    assert.equal(archived.source.filename, 'CIFP_260903.zip');
    assert.deepEqual(await fs.readdir(cache), []);
    assert.throws(() => parseCifpProcedures(archived.text, '2026-10-01'), /header does not match/);
});

test('NASR schemas and airport-to-body joins are validated even for empty tables', () => {
    assert.throws(() => buildTerminalProcedures({ ...topology,
        departureAirports: 'EFF_DATE,DP_COMPUTER_CODE,ARTCC\n' }, '2026-09-03'), /missing columns/);
    assert.throws(() => buildTerminalProcedures({ ...topology,
        departureAirports: topology.departureAirports.replace('MLPTS-TECKY', 'MISSING-BODY') }, '2026-09-03'), /has no route body/);
});

test('uncoded NASR records are accounted for without inventing filing identifiers', () => {
    const input = Object.fromEntries(Object.entries(topology).map(([key, value]) =>
        [key, key.startsWith('depart') ? String(value).replaceAll('SPTNS1.TECKY', 'NOT ASSIGNED') : value]));
    const data = buildTerminalProcedures(input as typeof topology, '2026-09-03');
    assert.equal(data.procedures.length, 1);
    assert.ok(data.excluded.some(row => row.table === 'BASE' && row.reason === 'unassigned-computer-code'));
    assert.equal(data.excluded.filter(row => row.table === 'RTE').length, data.sourceRows.DP_RTE);
});
