import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { buildApproachRoutes } from '../lib/approach-routes.ts';

// FAA CIFP 2609: KDEN I16L / I35R, with their airport, fixes and station records.
const source = fs.readFileSync(new URL('./fixtures/approach-localizer-dme-cifp.txt', import.meta.url), 'utf8');
const reference = (input: string) => buildApproachRoutes(input, '2026-09-03').procedures
    .find(p => p.id === 'KDEN:I16L')!.final.find(l => l.path === 'VD')!.reference!;
const antenna = (line: string) => line.slice(4, 6) === 'D ' && line.slice(13, 18).trim() === 'ILTT';

test('ILS DME uses its separate surveyed antenna, independent of record order', () => {
    const ref = reference(source);
    assert.equal(ref.id, 'PI:K2:ILTT:KDEN');
    assert.deepEqual(ref.dmeCoordinate, [-(104 + 41 / 60 + 1577 / 360000), 39 + 53 / 60 + 5961 / 360000]);
    assert.notDeepEqual(ref.dmeCoordinate, ref.coordinate);
    const lines = source.trimEnd().split('\n');
    assert.deepEqual(reference([lines[0], ...lines.slice(1).reverse()].join('\n')), ref);
});

test('missing, ambiguous, other-airport and other-region DME records cannot fill an ILS reference', () => {
    const lines = source.trimEnd().split('\n'), record = lines.find(antenna)!;
    const absent = lines.filter(l => !antenna(l)).join('\n');
    const elsewhere = record.slice(0, 6) + 'KXXX' + record.slice(10);
    const otherRegion = record.slice(0, 19) + 'K1' + record.slice(21);
    for (const input of [absent, absent + '\n' + elsewhere, absent + '\n' + otherRegion,
        source + record.slice(0, 55) + 'N40000000W105000000' + record.slice(74)]) {
        assert.equal(reference(input).dmeCoordinate, undefined);
        assert.ok(reference(input).coordinate, 'the surveyed localizer remains available');
    }
});
