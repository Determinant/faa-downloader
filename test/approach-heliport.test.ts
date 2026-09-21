import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { buildApproachRoutes } from '../lib/approach-routes.ts';

// FAA 2609 HA/HC/HF for 87N and KJRA, plus their enroute fixes/navaids.
const source = fs.readFileSync(new URL('./fixtures/approach-heliport-cifp.txt', import.meta.url), 'utf8');
test('heliport approaches retain terminal and enroute fixes, magnetic variation, MAP and missed hold', () => {
    const data = buildApproachRoutes(source, '2026-09-03');
    assert.equal(data.procedures.length, 2);
    for (const [id, variation, faf, map, hold, count] of [
        ['87N:R190', -14, 'STAYS', 'CRANN', 'BEADS', 6],
        ['KJRA:R210', -13, 'ERORE', 'JORBA', 'JEDIL', 7],
    ] as const) {
        const p = data.procedures.find(p => p.id === id)!;
        assert.equal(p.magneticVariation, variation);
        assert.equal(p.final.length, count, 'continuation records do not duplicate legs');
        assert.equal(p.final.find(l => l.fix?.role === 'FAF')!.fix!.ident, faf);
        assert.equal(p.final.find(l => l.fix?.role === 'MAP')!.fix!.ident, map);
        assert.equal(p.final.at(-1)!.path, 'HM');
        assert.equal(p.final.at(-1)!.missed, true);
        assert.equal(p.final.at(-1)!.fix!.ident, hold);
        assert.equal(p.transitions.length, 2);
    }
    assert.deepEqual(data.procedures.find(p => p.airport === 'KJRA')!.final[0]!.fix!.coordinate,
        [-73.87980833333333, 41.00265]);
});

test('HC coordinates are scoped by heliport, ICAO region and section', () => {
    const lines = source.split('\n');
    const jedil = lines.find(l => l[4] === 'H' && l[12] === 'C' && l.slice(13, 18) === 'JEDIL')!;
    const without = lines.filter(l => l !== jedil).join('\n') + '\n';
    const fix = (input: string) => buildApproachRoutes(input, '2026-09-03').procedures.find(p => p.airport === 'KJRA')!.final[0]!.fix;
    assert.equal(fix(without), undefined);
    for (const impostor of [jedil.slice(0, 6) + '87N ' + jedil.slice(10),
        jedil.slice(0, 19) + 'K2' + jedil.slice(21), jedil.slice(0, 4) + 'P' + jedil.slice(5)]) {
        assert.equal(fix(without + impostor + '\n'), undefined);
        assert.deepEqual(fix(source + impostor + '\n'), fix(source), 'a like-named fix elsewhere must not overwrite the correct position');
    }
});
