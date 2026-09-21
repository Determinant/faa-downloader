import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { buildApproachRoutes } from '../lib/approach-routes.ts';

// Public FAA CIFP 2609: KSFO I28R/R28L, KSBA I07 and KSNS I31, plus referenced fixes/navaids.
const source = fs.readFileSync(new URL('./fixtures/approach-cifp.txt', import.meta.url), 'utf8');
// Public FAA CIFP 2609: 12D R08, 2C8 R34 and KMWH N32R, with referenced navaids/fixes
// and the separate K5 MW station to exercise ICAO-region isolation.
const navaidSource = fs.readFileSync(new URL('./fixtures/approach-navaids-cifp.txt', import.meta.url), 'utf8');
test('FAA primary approach records retain published transitions, final, runway and missed hold', () => {
    const data = buildApproachRoutes(source, '2026-09-03');
    assert.equal(data.procedures.length, 4);
    const ils = data.procedures.find(p => p.id === 'KSFO:I28R')!;
    assert.deepEqual(ils.transitions.map(t => t.id), ['ARCHI', 'DUMBA', 'EDDYY', 'SIDBY']);
    assert.equal(ils.transitions[0].legs[0].fix.role, 'IAF');
    assert.equal(ils.transitions[0].legs.at(-1).fix.role, 'IF');
    assert.equal(ils.final[1].fix.ident, 'AXMUL');
    assert.equal(ils.final[1].fix.role, 'FAF');
    assert.equal(ils.final[2].fix.ident, 'RW28R');
    assert.ok(Math.abs(ils.final[2].fix.coordinate[0] + 122.35805833) < .00001);
    assert.equal(ils.final[3].missed, true);
    assert.equal(ils.final.at(-1).path, 'HM');
    assert.equal(ils.final.at(-1).fix.ident, 'VIKYU');
    assert.equal(ils.final.at(-1).turn, 'R');
    assert.equal(ils.final[2].magneticCourse, 284);
});

test('altitude legs remain endpoint-free and continuation records do not become route legs', () => {
    const rnav = buildApproachRoutes(source, '2026-09-03').procedures.find(p => p.id === 'KSFO:R28L')!;
    assert.equal(rnav.final.filter(leg => leg.fix?.ident === 'DUYET').length, 1);
    assert.deepEqual(rnav.final.find(leg => leg.path === 'CA'), { path: 'CA', id: 'R::040', gnssFms: 'A', qualifiers: 'JS', waypointDescriptor: '  M ', missed: true, magneticCourse: 283.9,
        altitude: { restriction: '+', first: '01020', second: '' } });
    const noFix = source.split('\n').filter(line => !(line[12] === 'C' && line.slice(13, 18) === 'AXMUL')).join('\n');
    assert.equal(buildApproachRoutes(noFix, '2026-09-03').procedures.find(p => p.id === 'KSFO:I28R').final[1].fix, undefined);
});

test('wrong cycles and empty CIFP procedure files are rejected', async () => {
    assert.throws(() => buildApproachRoutes(source, '2026-08-06'), /header/);
    assert.throws(() => buildApproachRoutes(source, '2026-09-04'), /header/);
});

test('malformed CIFP records fail instead of silently dropping an approach leg', () => {
    const truncated = source.split('\n').map(line => line.slice(6, 10) === 'KSFO' &&
        line.slice(13, 19).trim() === 'I28R' && line.slice(29, 34) === 'AXMUL' && line.slice(47, 49) === 'CF'
        ? line.slice(0, -1) : line).join('\n');
    assert.throws(() => buildApproachRoutes(truncated, '2026-09-03'), /CIFP record.*132/);
    assert.throws(() => buildApproachRoutes(source.replace(/^HDR01/, 'BAD01'), '2026-09-03'), /CIFP header/);
    assert.deepEqual(buildApproachRoutes(source.replaceAll('\n', '\r\n'), '2026-09-03'), buildApproachRoutes(source, '2026-09-03'));
});

test('invalid CIFP coordinates cannot be published or normalized into a different position', () => {
    const atAxmul = (position: string) => source.split('\n').map(line =>
        line[12] === 'C' && line.slice(13, 18) === 'AXMUL' ? line.slice(0, 32) + position + line.slice(51) : line).join('\n');
    for (const position of ['N91000000W122000000', 'N37600000W122000000', 'N37596000W122000000',
        'N90000001W122000000', 'N37000000W180000001', 'N37000000' + ' '.repeat(10)]) {
        assert.throws(() => buildApproachRoutes(atAxmul(position), '2026-09-03'), /Invalid CIFP coordinate/);
    }
    const parsed = buildApproachRoutes(atAxmul('N90000000E180000000'), '2026-09-03');
    assert.deepEqual(parsed.procedures.find(p => p.id === 'KSFO:I28R')!.final[1].fix!.coordinate, [180, 90]);
});

test('KSNS ARTYY exports its SNS 22 DME arc center, published radius and turn', () => {
    const arc = buildApproachRoutes(source, '2026-09-03').procedures.find(p => p.id === 'KSNS:I31')!
        .transitions.find(t => t.id === 'SNS2')!.legs.find(l => l.path === 'AF')!;
    assert.equal(arc.fix!.ident, 'AANNE');
    assert.equal(arc.turn, 'R');
    assert.equal(arc.radiusNm, 22);
    assert.deepEqual(arc.center, [-121.60318333333333, 36.66383888888889]);
    assert.equal(arc.distance, undefined, 'rho is the DME radius, not a route-leg distance');
});

test('holding records retain inbound course, timed or distance legs and airport variation', () => {
    const procedures = buildApproachRoutes(source, '2026-09-03').procedures;
    const salinas = procedures.find(p => p.id === 'KSNS:I31')!;
    assert.equal(salinas.magneticVariation, 13);
    const hold = salinas.final.at(-1)!;
    assert.equal(hold.path, 'HM'); assert.equal(hold.missed, true);
    assert.equal(hold.magneticCourse, 95); assert.equal(hold.turn, 'R');
    assert.equal(hold.holdMinutes, 1); assert.equal(hold.distance, undefined);
    const rnav = procedures.find(p => p.id === 'KSFO:R28L')!.final.at(-1)!;
    assert.equal(rnav.distance, 4); assert.equal(rnav.holdMinutes, undefined);
});

test('explicit true courses and west variation preserve their reference and sign', () => {
    const changed = source.split('\n').map(line => {
        if (line.slice(6, 10) !== 'KSNS') return line;
        if (line[12] === 'A') return line.slice(0, 51) + 'W0130' + line.slice(56);
        if (line.slice(47, 49) === 'HM') return line.slice(0, 70) + '095T' + line.slice(74);
        return line;
    }).join('\n');
    const salinas = buildApproachRoutes(changed, '2026-09-03').procedures.find(p => p.id === 'KSNS:I31')!;
    assert.equal(salinas.magneticVariation, -13);
    assert.equal(salinas.final.at(-1)!.trueCourse, 95);
    assert.equal(salinas.final.at(-1)!.magneticCourse, undefined);
});

test('DME arc centers use the antenna position and an exact four-character navaid reference', () => {
    const changed = source.split('\n').map(line => {
        if (line.slice(4, 6).trim() === 'D' && line.slice(13, 18).trim() === 'SNS') {
            return line.slice(0, 13) + 'TST1' + line.slice(17, 32) + 'N00000000E000000000' + line.slice(51);
        }
        if (line.slice(47, 49) === 'AF') return line.slice(0, 50) + 'TST1' + line.slice(54);
        return line;
    }).join('\n');
    const arc = buildApproachRoutes(changed, '2026-09-03').procedures.find(p => p.id === 'KSNS:I31')!
        .transitions.find(t => t.id === 'SNS2')!.legs.find(l => l.path === 'AF')!;
    assert.deepEqual(arc.center, [-121.60318333333333, 36.66383888888889], 'the offset VOR position must not become the arc center');
    const noDme = changed.split('\n').map(line => line.slice(4, 6).trim() === 'D'
        ? line.slice(0, 55) + ' '.repeat(19) + line.slice(74) : line).join('\n');
    assert.equal(buildApproachRoutes(noDme, '2026-09-03').procedures.find(p => p.id === 'KSNS:I31')!
        .transitions.find(t => t.id === 'SNS2')!.legs.find(l => l.path === 'AF')!.center, undefined);
});

test('DME and TACAN-only stations retain approach entry, missed fix and hold positions', () => {
    const procedures = buildApproachRoutes(navaidSource, '2026-09-03').procedures;
    const elo = { ident: 'ELO', coordinate: [-(91 + 49 / 60 + 4851 / 360000), 47 + 49 / 60 + 1884 / 360000] };
    const hml = { ident: 'HML', coordinate: [-(97 + 7 / 60 + 445 / 360000), 48 + 52 / 60 + 907 / 360000] };
    for (const [id, fix] of [['12D:R08', elo], ['2C8:R34', hml]] as const) {
        const missed = procedures.find(p => p.id === id)!.final.filter(leg => leg.missed && ['DF', 'HM'].includes(leg.path));
        assert.deepEqual(missed.map(leg => leg.path), ['DF', 'HM']);
        assert.deepEqual(missed.map(leg => leg.fix), [fix, fix]);
    }
    const entry = procedures.find(p => p.id === '2C8:R34')!.transitions.find(t => t.id === 'HML')!.legs[0];
    assert.equal(entry.path, 'IF');
    assert.deepEqual(entry.fix, hml);
});

test('VOR fix positions take precedence over offset DME antennas, and missing positions stay missing', () => {
    const replaceElo = (position: string, removeDme = false) => navaidSource.split('\n').map(line => {
        if (line.slice(4, 6) !== 'D ' || line.slice(13, 18).trim() !== 'ELO') return line;
        const changed = line.slice(0, 32) + position + line.slice(51);
        return removeDme ? changed.slice(0, 55) + ' '.repeat(19) + changed.slice(74) : changed;
    }).join('\n');
    const hold = (input: string) => buildApproachRoutes(input, '2026-09-03').procedures.find(p => p.id === '12D:R08')!.final.at(-1)!;
    assert.deepEqual(hold(replaceElo('N48000000W092000000')).fix, { ident: 'ELO', coordinate: [-92, 48] });
    assert.equal(hold(replaceElo(' '.repeat(19), true)).fix, undefined);
});

test('terminal NDB references resolve matching DB records without crossing ICAO regions', () => {
    const approach = buildApproachRoutes(navaidSource, '2026-09-03').procedures.find(p => p.id === 'KMWH:N32R')!;
    const coordinate = [-(119 + 16 / 60 + 2823 / 360000), 47 + 6 / 60 + 5656 / 360000];
    assert.deepEqual(approach.final[0].fix, { ident: 'MW', coordinate, role: 'FAF' });
    for (const transition of approach.transitions) {
        assert.equal(transition.legs[1].path, 'TF');
        assert.deepEqual(transition.legs[1].fix, { ident: 'MW', coordinate });
    }
    const otherRegionOnly = navaidSource.split('\n').filter(line =>
        !(line.slice(4, 6) === 'DB' && line.slice(13, 18).trim() === 'MW' && line.slice(19, 21) === 'K1')).join('\n');
    assert.equal(buildApproachRoutes(otherRegionOnly, '2026-09-03').procedures.find(p => p.id === 'KMWH:N32R')!.final[0].fix, undefined);
});

test('explicit terminal NDB positions take precedence and remain scoped to their airport', () => {
    const station = navaidSource.split('\n').find(line =>
        line.slice(4, 6) === 'DB' && line.slice(13, 18).trim() === 'MW' && line.slice(19, 21) === 'K1')!;
    const terminal = (airport: string) => station.slice(0, 4) + 'P ' + airport + 'K1N' + station.slice(13, 32) +
        'N48000000W120000000' + station.slice(51) + '\n';
    const faf = (input: string) => buildApproachRoutes(input, '2026-09-03').procedures.find(p => p.id === 'KMWH:N32R')!.final[0].fix;
    const elsewhere = navaidSource + terminal('KXXX');
    assert.deepEqual(faf(elsewhere), faf(navaidSource));
    assert.deepEqual(faf(elsewhere + terminal('KMWH')), { ident: 'MW', coordinate: [-120, 48], role: 'FAF' });
    const noDb = elsewhere.split('\n').filter(line => line.slice(4, 6) !== 'DB').join('\n');
    assert.equal(faf(noDb), undefined, 'a terminal station at another airport is not a fallback');
});

const pathSource = fs.readFileSync(new URL('./fixtures/approach-paths-cifp.txt', import.meta.url), 'utf8');
test('raw CIFP retains scoped station/localizer references, radial/range conditions and source sequences', () => {
    const data = buildApproachRoutes(pathSource, '2026-09-03');
    assert.equal(data.metadata.schemaVersion, 2);
    assert.equal(data.procedures.length, 16);
    assert.deepEqual(data.unavailable, []);
    const final = (id: string) => data.procedures.find(p => p.id === id)!.final;
    const willows = final('KWLW:S34').find(l => l.path === 'CF')!;
    assert.equal(willows.reference!.ident, 'ILA');
    assert.equal(willows.reference!.declination, 18);
    assert.equal(willows.radial, 323);
    assert.equal(willows.reference!.id, 'D:K2:ILA:');
    assert.equal(data.procedures.find(p => p.id === 'KWLW:S34')!.magneticVariation, 14);
    const radial = final('KLAX:I25L').find(l => l.path === 'VR')!;
    assert.ok(radial.reference!.coordinate);
    assert.ok(radial.reference!.declination !== undefined);
    assert.ok(radial.radial !== undefined);
    const range = final('KVNY:I16RZ').find(l => l.path === 'CD')!;
    assert.equal(range.reference!.ident, 'VNY');
    assert.ok(range.reference!.dmeCoordinate);
    assert.equal(range.distance, 1.5);
    const localizer = final('KNUQ:I32R').find(l => l.reference?.type === 'localizer')!.reference!;
    assert.equal(localizer.ident, 'INUQ');
    assert.equal(localizer.declination, 16);
    assert.ok(localizer.coordinate);
    const climb = final('KOAK:I28R').find(l => l.path === 'CA')!;
    assert.equal(climb.altitude!.first, '01900');
    assert.equal(climb.fix, undefined);
    assert.match(climb.id, /^[A-Z]:[^:]*:\d{3}$/);
    const missing = pathSource.split('\n').filter(l => !(l.slice(4, 6) === 'D ' && l.slice(13, 18).trim() === 'ILA')).join('\n');
    const unresolved = buildApproachRoutes(missing, '2026-09-03').procedures.find(p => p.id === 'KWLW:S34')!.final.find(l => l.path === 'CF')!;
    assert.equal(unresolved.reference!.id, willows.reference!.id);
    assert.equal(unresolved.reference!.coordinate, undefined);
    assert.equal(unresolved.reference!.declination, undefined);
});

test('unavailable main branches retain their source legs instead of silently disappearing', () => {
    const main = source.split('\n').filter(l => l.slice(6, 10) === 'KSFO' && l.slice(13, 19).trim() === 'I28R' && l[19] !== 'A');
    const data = buildApproachRoutes(source + '\n' + main.map(l => l.slice(0, 19) + 'Z' + l.slice(20)).join('\n'), '2026-09-03');
    assert.ok(!data.procedures.some(p => p.id === 'KSFO:I28R'));
    const unavailable = data.unavailable.find(p => p.id === 'KSFO:I28R')!;
    assert.equal(unavailable.reason, 'multiple-main-branches');
    assert.equal(unavailable.branches.length, 6);
    assert.ok(unavailable.branches.every(b => b.legs.length && b.legs.every(l => l.id)));
    const missing = buildApproachRoutes(source.split('\n').filter(l => !main.includes(l)).join('\n'), '2026-09-03');
    assert.equal(missing.unavailable.find(p => p.id === 'KSFO:I28R')!.reason, 'missing-main-branch');
});
