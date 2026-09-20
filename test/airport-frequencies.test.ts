import assert from 'node:assert/strict';
import test from 'node:test';
import { airportFrequencyIndex } from '../lib/airport-frequencies.ts';

const airport = { SITE_NO: '001.', SITE_TYPE_CODE: 'A', ARPT_ID: 'ABC', STATE_CODE: 'CA', COUNTRY_CODE: 'US' };
const frequency = { FACILITY: 'OTHER', SERVICED_FACILITY: 'ABC', SERVICED_STATE: 'CA', SERVICED_COUNTRY: 'US',
    SERVICED_SITE_TYPE: 'AIRPORT', FACILITY_TYPE: 'ATCT', FREQ: '118.025', FREQ_USE: 'LCL/P' };

test('airport communications join the serviced airport, retain precision and operational restrictions, and deduplicate exact rows', () => {
    const row = { ...frequency, SECTORIZATION: 'RWY 12/30', TOWER_HRS: '0700-2100', REMARK: 'WHEN TOWER OPEN' };
    assert.deepEqual(airportFrequencyIndex([airport], [row, row]).get('001.:A'), [{
        type: 'TOWER', frequencyMHz: 118.025, use: 'LCL/P', sector: 'RWY 12/30', hours: '0700-2100', remarks: 'WHEN TOWER OPEN'
    }]);
    const multiple = airportFrequencyIndex([airport], [row, { ...row, SECTORIZATION: 'RWY 03/21' }]);
    assert.equal(multiple.get('001.:A')?.length, 2, 'different published sectors are not collapsed');
});

test('weather, tower, CTAF, and ground keep service identity without treating UNICOM or approach as CTAF', () => {
    const rows = ['ATIS', 'D-ATIS', 'LCL/P', 'LCL/S', 'GND/P', 'GND/S', 'CTAF', 'UNICOM', 'APCH/P DEP/P']
        .map(FREQ_USE => ({ ...frequency, FREQ_USE }));
    rows.push({ ...frequency, FACILITY_TYPE: 'ASOS_AWOS', SERVICED_SITE_TYPE: 'AWOS-3', FREQ_USE: 'ABC AWOS-3' });
    rows.push({ ...frequency, FACILITY_TYPE: 'ASOS_AWOS', SERVICED_SITE_TYPE: 'ASOS', FREQ_USE: 'ABC ASOS' });
    assert.deepEqual(airportFrequencyIndex([airport], rows).get('001.:A')?.map(row => row.type),
        ['ATIS', 'D-ATIS', 'TOWER', 'TOWER', 'GROUND', 'GROUND', 'CTAF', 'AWOS', 'ASOS']);
});

test('communications do not cross facility types, state/country identities, or ambiguous matches', () => {
    const unrelated = [
        { ...frequency, SERVICED_FACILITY: 'XYZ', FACILITY: 'ABC' },
        { ...frequency, SERVICED_STATE: 'NV' }, { ...frequency, SERVICED_COUNTRY: 'CA' },
        { ...frequency, SERVICED_SITE_TYPE: 'VOR/DME' },
        { ...frequency, FREQ: '' }, { ...frequency, FREQ: '118.0/32' }, { ...frequency, FREQ: 'NaN' },
        { ...frequency, FREQ: '0' }
    ];
    assert.equal(airportFrequencyIndex([airport], unrelated).size, 0);
    assert.equal(airportFrequencyIndex([airport, { ...airport, SITE_NO: '002.' }], [frequency]).size, 0);
    const heliport = { ...airport, SITE_NO: '002.', SITE_TYPE_CODE: 'H' };
    assert.deepEqual([...airportFrequencyIndex([airport, heliport], [{ ...frequency, SERVICED_SITE_TYPE: 'HELIPORT' }]).keys()], ['002.:H']);
});

test('communications join every FAA APT facility code, including C for seaplane bases', () => {
    const facilities = [
        ['A', 'AIRPORT'], ['H', 'HELIPORT'], ['C', 'SEAPLANE BASE'],
        ['G', 'GLIDERPORT'], ['B', 'BALLOONPORT'], ['U', 'ULTRALIGHT']
    ];
    // A shared identifier forces the join to discriminate by the official APT site code.
    const airports = facilities.map(([SITE_TYPE_CODE], i) => ({ ...airport, SITE_NO: `${i}.`, SITE_TYPE_CODE }));
    const rows = facilities.map(([, SERVICED_SITE_TYPE], i) => ({ ...frequency, SERVICED_SITE_TYPE,
        FREQ_USE: 'CTAF', FREQ: String(122 + i / 10) }));
    const index = airportFrequencyIndex(airports, rows);
    assert.equal(index.size, facilities.length);
    facilities.forEach(([code], i) => assert.deepEqual(index.get(`${i}.:${code}`), [
        { type: 'CTAF', frequencyMHz: 122 + i / 10, use: 'CTAF' }
    ]));
    assert.equal(airportFrequencyIndex([{ ...airport, SITE_TYPE_CODE: 'S' }], [rows[2]]).size, 0,
        'an invented seaplane code must not match');
});
