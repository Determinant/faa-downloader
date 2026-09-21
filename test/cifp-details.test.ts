import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { parseCifpProcedures } from '../lib/cifp.ts';

const raw = await fs.readFile(new URL('./fixtures/terminal-cifp.txt', import.meta.url), 'utf8');
const parse = (input = raw) => parseCifpProcedures(input, '2026-09-03');
const change = (line: string, start: number, value: string) => line.slice(0, start) + value + line.slice(start + value.length);

test('all declared continuations are attached to primary legs, including published service names', () => {
    const data = parse();
    const extensions = data.procedures.flatMap(p => p.branches.flatMap(b => b.legs.flatMap(l => l.continuations ?? [])));
    assert.equal(extensions.length, 2);
    assert.equal(data.exportedContinuations, data.continuationRecords);
    assert.ok(extensions.every(c => c.raw.length === 132 && c.application === 'W' && c.services?.length === 3));
    assert.ok(extensions.some(c => c.services?.some(s => s.name === 'LNAV' && s.authorization === 'A')));
    const continuation = raw.split('\n').find(l => l[38] === '2' && l[39] === 'W')!;
    assert.throws(() => parse(raw.replace(continuation + '\n', '')), /Missing CIFP continuation/);
    assert.throws(() => parse(raw + continuation + '\n'), /Duplicate CIFP continuation/);
    assert.throws(() => parse(raw.replace(continuation, change(continuation, 29, 'WRONG'))), /does not match/);
});

test('speed, RNP, angles and qualifiers retain source units and restrictions', () => {
    const data = parse();
    const sid = data.procedures.find(p => p.ident === 'SPTNS1')!;
    assert.deepEqual(sid.branches[0]!.legs[1]!.speed, { knots: 230, restriction: '-' });
    assert.ok(data.procedures.flatMap(p => p.branches.flatMap(b => b.legs)).some(l => l.verticalAngle === -3));
    const line = raw.split('\n').find(l => l[12] === 'D' && l[38] === '0')!;
    const modified = change(change(line, 44, '152'), 99, '210');
    const leg = parse(raw.replace(line, modified)).procedures.find(p => p.ident === 'SPTNS1')!.branches[0]!.legs[0]!;
    assert.equal(leg.rnpNm, .15);
    assert.equal(leg.speed?.knots, 210);
    assert.throws(() => parse(raw.replace(line, change(line, 44, 'XYZ'))), /Invalid CIFP RNP/);
});

test('airport reference points resolve with exact section, region and identity', () => {
    const line = raw.split('\n').find(l => l[12] === 'D' && l[38] === '0')!;
    let modified = change(line, 29, 'KSJC K2PA');
    modified = change(modified, 47, 'DF');
    const leg = parse(raw.replace(line, modified)).procedures.find(p => p.ident === 'SPTNS1')!.branches[0]!.legs[0]!;
    assert.equal(leg.fix?.ident, 'KSJC');
    assert.ok(leg.fix?.coordinate.every(Number.isFinite));
    const wrongRegion = parse(raw.replace(line, change(modified, 34, 'K1'))).procedures.find(p => p.ident === 'SPTNS1')!.branches[0]!.legs[0]!;
    assert.equal(wrongRegion.fix, undefined);
});
