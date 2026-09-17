import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildTerminalProcedures, type TerminalProcedureInput } from '../lib/terminal-procedures.ts';

// Subset of FAA's 2026-09-03 DP/STAR CSVs, retaining both runway branches.
const input: TerminalProcedureInput = JSON.parse(readFileSync(new URL('./fixtures/terminal-procedures.json', import.meta.url), 'utf8'));
const build = (overrides: Partial<TerminalProcedureInput> = {}) => buildTerminalProcedures({ ...input, ...overrides }, '2026-09-03');

test('exports FAA computer identities, ordered transitions, and airport/runway associations', () => {
    const { procedures } = build();
    assert.deepEqual(procedures.map(procedure => procedure.ident), ['SPTNS1', 'OHSEA3']);
    const sid = procedures[0]!;
    assert.equal(sid.kind, 'departure');
    assert.deepEqual(sid.airports, ['SJC']);
    assert.deepEqual(sid.routes.filter(route => route.kind === 'body').flatMap(route => route.airports), [
        { ident: 'SJC', runway: '30R' }, { ident: 'SJC', runway: '30L' }
    ]);
    assert.deepEqual(sid.routes.find(route => route.transition === 'SPTNS1.VLREE')!.points.map(point => point.ident), ['TECKY', 'VLREE']);
    assert.deepEqual(procedures[1]!.routes.find(route => route.transition === 'ELLBC.OHSEA3')!.points.map(point => point.ident),
        ['ELLBC', 'GOONA', 'GUDBY', 'YORBS', 'PCIFC']);
});

test('splits served airports on whitespace or commas for both SIDs and STARs', () => {
    for (const separator of [' ', ',', ', ', '\t', ' ,\t ']) {
        const { procedures } = build({
            departures: input.departures.replace('"SJC"', `"${['SJC', 'SFO', 'OAK'].join(separator)}"`),
            arrivals: input.arrivals.replace('"SNA"', `"${['SNA', 'LGB'].join(separator)}"`)
        });
        assert.deepEqual(procedures[0]!.airports, ['SJC', 'SFO', 'OAK'], separator);
        assert.deepEqual(procedures[1]!.airports, ['SNA', 'LGB'], separator);
        assert.deepEqual(procedures.map(procedure => procedure.routes), build().procedures.map(procedure => procedure.routes),
            'served-airport lists do not change individual body/runway associations');
    }
});

test('rejects mixed cycles, orphan routes, duplicate points, and malformed assigned codes', () => {
    assert.throws(() => build({ arrivalRoutes: input.arrivalRoutes.replace('2026/09/03', '2026/10/01') }), /effective date/);
    assert.throws(() => build({ departureRoutes: input.departureRoutes.replace('SPTNS1.TECKY', 'UNKNOWN.FIX') }), /no parent/);
    assert.throws(() => build({ departureRoutes: input.departureRoutes + input.departureRoutes.split('\n')[1] + '\n' }), /Duplicate.*sequence/);
    assert.throws(() => build({ departures: input.departures.replace('SPTNS1.TECKY', 'BADCODE') }), /Invalid procedure code/);
});

test('rejects header-only procedure groups rather than exporting a missing SID or STAR catalog', () => {
    for (const keys of [
        ['departures', 'departureAirports', 'departureRoutes'],
        ['arrivals', 'arrivalAirports', 'arrivalRoutes'],
        Object.keys(input)
    ]) {
        const empty = Object.fromEntries(keys.map(key => [key, input[key].split('\n')[0] + '\n']));
        assert.throws(() => build(empty), /BASE\.csv contains no procedures/);
    }
});

test('retains source discontinuities and never invents associations for unassociated bodies', () => {
    const result = build({ departureAirports: input.departureAirports.split('\n')[0]! + '\n',
        departureRoutes: input.departureRoutes.replace('"WP   ","SPTNS"', '"WP   ",""') });
    const body = result.procedures[0]!.routes[0]!;
    assert.deepEqual(body.airports, []);
    assert.equal(body.points[0]!.next, undefined);
    assert.deepEqual(build({ departureRoutes: input.departureRoutes.split('\n')[0] + '\n' }).procedures[0]!.routes, []);
});

test('uncoded FAA procedures are not assigned made-up filing identifiers', () => {
    const result = build(Object.fromEntries(Object.entries(input).map(([key, value]) =>
        [key, key.startsWith('depart') ? value.replaceAll('SPTNS1.TECKY', 'NOT ASSIGNED') : value])));
    assert.deepEqual(result.procedures.map(procedure => procedure.ident), ['OHSEA3']);
});
