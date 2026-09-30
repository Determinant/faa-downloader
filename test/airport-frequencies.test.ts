import assert from 'node:assert/strict';
import test from 'node:test';
import { airportFrequencyIndex, airportFrequencyProperties } from '../lib/airport-frequencies.ts';

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

test('weather and communications keep service identity without treating UNICOM or approach as CTAF', () => {
    const rows = ['ATIS', 'D-ATIS', 'LCL/P', 'LCL/S', 'GND/P', 'GND/S', 'CTAF', 'UNICOM', 'APCH/P DEP/P']
        .map(FREQ_USE => ({ ...frequency, FREQ_USE }));
    rows.push({ ...frequency, FACILITY_TYPE: 'ASOS_AWOS', SERVICED_SITE_TYPE: 'AWOS-3', FREQ_USE: 'ABC AWOS-3' });
    rows.push({ ...frequency, FACILITY_TYPE: 'ASOS_AWOS', SERVICED_SITE_TYPE: 'ASOS', FREQ_USE: 'ABC ASOS' });
    assert.deepEqual(airportFrequencyIndex([airport], rows).get('001.:A')?.map(row => row.type),
        ['ATIS', 'D-ATIS', 'TOWER', 'TOWER', 'GROUND', 'GROUND', 'CTAF', 'APPROACH/DEPARTURE', 'AWOS', 'ASOS']);
});

test('clearance, approach and departure preserve combined services, sectors, priorities and restrictions', () => {
    const uses = ['CD/P', 'CD/S', 'CD PRE TAXI CLNC', 'CD PRE DEP CLNC', 'APCH/P', 'APCH/S',
        'DEP/P', 'DEP/S', 'APCH/P DEP/P IC', 'APCH/S DEP/S', 'APCH/DEP/P'];
    const rows = uses.map(FREQ_USE => ({ ...frequency, FACILITY_TYPE: 'TRACON', FREQ_USE,
        SECTORIZATION: '090-180', REMARK: 'CONTACT BEFORE ENTERING', TOWER_HRS: '0700-2100' }));
    const excluded: string[] = [];
    const result = airportFrequencyIndex([airport], [...rows, rows[8]], (_row, reason) => excluded.push(reason)).get('001.:A')!;
    assert.deepEqual(result.map(row => row.type), ['CLEARANCE', 'CLEARANCE', 'CLEARANCE', 'CLEARANCE',
        'APPROACH', 'APPROACH', 'DEPARTURE', 'DEPARTURE', 'APPROACH/DEPARTURE', 'APPROACH/DEPARTURE', 'APPROACH/DEPARTURE']);
    assert.deepEqual(result.map(row => row.use), uses);
    assert.ok(result.every(row => row.sector === '090-180' && row.remarks === 'CONTACT BEFORE ENTERING' && row.hours === '0700-2100'));
    assert.deepEqual(excluded, ['duplicate-service']);
    const other = ['CD NDB', 'CDA AWOS-3', 'FINAL APCH', 'SANTA MONICA DP', 'DE/P', 'UNICOM']
        .map(FREQ_USE => ({ ...frequency, FREQ_USE }));
    assert.equal(airportFrequencyIndex([airport], other).size, 0);
    assert.equal(airportFrequencyIndex([airport], rows.map(row => ({ ...row, SERVICED_STATE: 'NV' }))).size, 0);
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

test('terminal names come from the servicing provider, including secondary and departure channels', () => {
    const self = { ...frequency, FACILITY: 'NCT', FACILITY_TYPE: 'TRACON', FAC_NAME: 'NORTHERN CALIFORNIA TRACON',
        SERVICED_FACILITY: 'NCT', SERVICED_SITE_TYPE: 'TRACON', PRIMARY_APPROACH_RADIO_CALL: 'NORCAL', FREQ_USE: 'EMERG' };
    const rows = ['APCH/P', 'APCH/S', 'DEP/P', 'APCH/P DEP/P', 'CD/P'].map(FREQ_USE => ({
        ...self, SERVICED_FACILITY: 'ABC', SERVICED_SITE_TYPE: 'AIRPORT', FREQ_USE,
        TOWER_OR_COMM_CALL: 'LOCAL TOWER', PRIMARY_APPROACH_RADIO_CALL: 'OTHER PRIMARY APPROACH'
    }));
    const records = airportFrequencyIndex([airport], [...rows, self]).get('001.:A')!;
    assert.ok(records.every(record => record.facilityId === 'NCT' && record.facilityName === 'NORCAL'));
    const missing = airportFrequencyIndex([airport], [rows[0]]).get('001.:A')![0];
    assert.equal(missing.facilityName, 'NORTHERN CALIFORNIA TRACON', 'fall back to the provider name, never another primary approach');
    const ambiguous = airportFrequencyIndex([airport], [self, { ...self, PRIMARY_APPROACH_RADIO_CALL: 'CONFLICT' }, rows[0]])
        .get('001.:A')![0];
    assert.equal(ambiguous.facilityName, 'NORTHERN CALIFORNIA TRACON');
    const local = { ...frequency, FACILITY: 'ABC', FAC_NAME: 'TEST AIRPORT', TOWER_OR_COMM_CALL: 'TEST TOWER',
        PRIMARY_APPROACH_RADIO_CALL: 'REMOTE APPROACH', FREQ_USE: 'CD/P' };
    assert.equal(airportFrequencyIndex([airport], [local]).get('001.:A')![0].facilityName, 'TEST TOWER');
});

test('Center channels use explicit airport associations and the owning ARTCC, retaining RCAG and altitude notes', () => {
    const apt = { ...airport, RESP_ARTCC_ID: 'ZOA', ARTCC_NAME: 'OAKLAND' };
    const center = { ...frequency, FACILITY: 'SQUAW VALLEY', FAC_NAME: 'SQUAW VALLEY', FACILITY_TYPE: 'RCAG',
        ARTCC_OR_FSS_ID: 'ZOA', FREQ: '127.95', FREQ_USE: 'SQUAW VALLEY RCAG', SECTORIZATION: 'LOW',
        TOWER_OR_COMM_CALL: 'LOCAL TOWER', PRIMARY_APPROACH_RADIO_CALL: 'UNRELATED APPROACH', REMARK: 'WHEN APPROACH CLOSED' };
    const records = airportFrequencyIndex([apt], [frequency, { ...frequency, FREQ_USE: 'APCH/P' }, center,
        { ...center, SERVICED_FACILITY: 'OTHER' }, { ...center, SERVICED_SITE_TYPE: 'RCAG' },
        { ...center, FACILITY_TYPE: 'RCO' }]).get('001.:A')!;
    const properties = airportFrequencyProperties(records);
    assert.deepEqual(properties.frequencies.map(record => record.type), ['TOWER']);
    assert.deepEqual(properties.terminalFrequencies?.map(record => record.type), ['APPROACH']);
    assert.deepEqual(properties.centerFrequencies, [{ type: 'CENTER', frequencyMHz: 127.95, use: 'SQUAW VALLEY RCAG',
        facilityId: 'ZOA', facilityName: 'OAKLAND', sector: 'LOW', remarks: 'WHEN APPROACH CLOSED' }]);
    const unknown = airportFrequencyIndex([apt], [{ ...center, ARTCC_OR_FSS_ID: 'ZXX' }]).get('001.:A')![0];
    assert.equal(unknown.facilityId, 'ZXX');
    assert.equal(unknown.facilityName, undefined, 'a remote transmitter name is not the Center name');
    assert.deepEqual(airportFrequencyProperties(), { frequencies: [] });
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
