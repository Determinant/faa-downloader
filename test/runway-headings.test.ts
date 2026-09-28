import assert from 'node:assert/strict';
import test from 'node:test';
import { addCifpRunwayHeadings } from '../lib/runway-headings.ts';
import type { NasrFeatureCollection } from '../lib/nasr.ts';

function record(airport: string, runway: string, bearing: string, continuation = '0') {
    const line = Array<string>(132).fill(' ');
    for (const [offset, value] of [[0, 'S'], [4, 'P'], [6, airport], [12, 'G'], [13, runway], [21, continuation], [27, bearing]] as const) {
        line.splice(offset, value.length, ...value);
    }
    return line.join('');
}
function fixture() {
    const ends = [{ id: '04L' }, { id: '22R', trueHeadingDeg: 235 }];
    const airports: NasrFeatureCollection = { type: 'FeatureCollection', metadata: { effectiveDate: '2026-09-03', source: 'NASR' },
        features: [{ type: 'Feature', id: 'airport:SLI', geometry: { type: 'Point', coordinates: [-118, 33] },
            properties: { icaoId: 'KSLI', runways: [{ id: '04L/22R', ends }] } }] };
    return { airports, ends };
}
test('joins published CIFP magnetic headings while retaining NASR data', () => {
    const { airports, ends } = fixture();
    assert.equal(addCifpRunwayHeadings(airports, [record('KSLI', 'RW04L', '0430'), record('KSLI', 'RW22R', '2230', '1'),
        record('KSLI', 'RW04L', '9999', '2'), record('KXXX', 'RW04L', '1000')].join('\n')), 2);
    assert.deepEqual(ends, [{ id: '04L', magneticHeadingDeg: 43 }, { id: '22R', trueHeadingDeg: 235, magneticHeadingDeg: 223 }]);
});
test('does not estimate missing, true, invalid or conflicting bearings', () => {
    for (const fields of [['    '], ['043T'], ['3610'], ['0430', '0440'], ['0430', '    '], ['    ', '0430']]) {
        const { airports, ends } = fixture();
        assert.equal(addCifpRunwayHeadings(airports, fields.map(field => record('KSLI', 'RW04L', field)).join('\n')), 0);
        assert.deepEqual(ends[0], { id: '04L' });
    }
    const { airports } = fixture();
    assert.equal(addCifpRunwayHeadings(airports, [record('KSLI', 'RW04L', '0430'), record('KSLI', 'RW04L', '0430')].join('\n')), 1);
    assert.throws(() => addCifpRunwayHeadings(airports, record('KSLI', 'RW04L', '0430').slice(0, 100)), /132/);
});


test('uses the published FAA identifier when ICAO is absent and prefers ICAO when present', () => {
    for (const icaoId of [undefined, '']) {
        const { airports, ends } = fixture();
        Object.assign(airports.features[0].properties, { icaoId, faaId: '26A' });
        ends[0].id = '27';
        assert.equal(addCifpRunwayHeadings(airports, [record('26A', 'RW27', '2710'),
            record('K26A', 'RW27', '0900'), record('26B', 'RW27', '1800')].join('\n')), 1);
        assert.deepEqual(ends[0], { id: '27', magneticHeadingDeg: 271 });
    }
    const { airports, ends } = fixture();
    airports.features[0].properties.faaId = 'SLI';
    assert.equal(addCifpRunwayHeadings(airports, [record('KSLI', 'RW04L', '0430'),
        record('SLI', 'RW04L', '0900')].join('\n')), 1);
    assert.deepEqual(ends[0], { id: '04L', magneticHeadingDeg: 43 });
});

test('preserves published runway suffixes and named ends while requiring an exact NASR match', () => {
    for (const [airport, id, sourceId, bearing] of [
        ['KBDU', '08G', 'RW08G', '0780'], ['KSUU', '032', 'RW032', '0347'],
        ['KFIN', '18W', 'RW18W', '1790'], ['KSER', '09U', 'RW09U', '0920'],
        ['PAIL', 'N', 'N', '0046'], ['KAPF', 'NE', 'NE', '0470'],
    ]) {
        const { airports, ends } = fixture();
        airports.features[0].properties.icaoId = airport;
        ends[0].id = id;
        assert.equal(addCifpRunwayHeadings(airports, [record(airport, sourceId, bearing),
            record(airport, 'RW08', '0900'), record('KXXX', sourceId, '1800')].join('\n')), 1);
        assert.deepEqual(ends[0], { id, magneticHeadingDeg: Number(bearing) / 10 });
    }
    const { airports, ends } = fixture();
    ends[0].id = '08G';
    assert.equal(addCifpRunwayHeadings(airports, record('KSLI', 'RW08', '0900')), 0);
    assert.deepEqual(ends[0], { id: '08G' });
});
