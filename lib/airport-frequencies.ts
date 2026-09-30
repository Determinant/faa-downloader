import type { CsvRecord } from './csv.ts';

type Service = 'ATIS' | 'D-ATIS' | 'AWOS' | 'ASOS' | 'TOWER' | 'CTAF' | 'GROUND'
    | 'CLEARANCE' | 'APPROACH' | 'DEPARTURE' | 'APPROACH/DEPARTURE' | 'CENTER';
type AirportFrequency = {
    type: Service;
    frequencyMHz: number;
    use: string;
    facilityId?: string;
    facilityName?: string;
    sector?: string;
    /** FAA TOWER_HRS, describing the tower rather than this individual service. */
    hours?: string;
    remarks?: string;
};
const SITE_TYPES: Record<string, string> = {
    A: 'AIRPORT', H: 'HELIPORT', C: 'SEAPLANE BASE', G: 'GLIDERPORT',
    B: 'BALLOONPORT', U: 'ULTRALIGHT'
};
const text = (value: string | undefined) => value?.trim() || '';
const identity = (id: string, state: string, country: string) => [id, state, country].join(':').toUpperCase();

/** Older PWAs validate a closed service enum in frequencies[] and ignore new properties. */
export function airportFrequencyProperties(records: readonly AirportFrequency[] = []) {
    const frequencies: AirportFrequency[] = [], terminalFrequencies: AirportFrequency[] = [], centerFrequencies: AirportFrequency[] = [];
    for (const record of records) {
        const terminal = ['CLEARANCE', 'APPROACH', 'DEPARTURE', 'APPROACH/DEPARTURE'].includes(record.type);
        (record.type === 'CENTER' ? centerFrequencies : terminal ? terminalFrequencies : frequencies).push(record);
    }
    return { frequencies, ...(terminalFrequencies.length ? { terminalFrequencies } : {}),
        ...(centerFrequencies.length ? { centerFrequencies } : {}) };
}

function facilityNames(airports: CsvRecord[], rows: CsvRecord[]) {
    const approachCalls = new Map<string, Set<string>>(), towerCalls = new Map<string, Set<string>>();
    const centers = new Map<string, Set<string>>(), centerFacilities = new Map<string, Set<string>>();
    const add = (index: Map<string, Set<string>>, key: string, value: string) => {
        if (!key || !value) return;
        const names = index.get(key) ?? new Set<string>();
        names.add(value); index.set(key, names);
    };
    const providerKey = (row: CsvRecord) => `${text(row.FACILITY_TYPE)}:${text(row.FACILITY)}`;
    for (const airport of airports) add(centers, text(airport.RESP_ARTCC_ID), text(airport.ARTCC_NAME));
    for (const row of rows) {
        if (!text(row.FACILITY) || text(row.FACILITY) !== text(row.SERVICED_FACILITY)) continue;
        const key = providerKey(row);
        // Calls on a serviced airport's row describe that airport's tower and
        // primary approach. Resolve the provider's own record for other services.
        add(towerCalls, key, text(row.TOWER_OR_COMM_CALL));
        if (/TRACON|RAPCON|RATCF|A\/C|CERAP/.test(text(row.FACILITY_TYPE))) {
            add(approachCalls, key, text(row.PRIMARY_APPROACH_RADIO_CALL));
        }
        if (['ARTCC', 'CERAP'].includes(text(row.FACILITY_TYPE))) {
            add(centerFacilities, text(row.FACILITY), text(row.FAC_NAME));
        }
    }
    const unique = (index: Map<string, Set<string>>, key: string) => {
        const names = index.get(key);
        return names?.size === 1 ? [...names][0] : undefined;
    };
    return (row: CsvRecord, type: Service) => {
        if (!['CLEARANCE', 'APPROACH', 'DEPARTURE', 'APPROACH/DEPARTURE', 'CENTER'].includes(type)) return {};
        const center = ['RCAG', 'ARTCC'].includes(text(row.FACILITY_TYPE));
        const facilityId = text(row.FACILITY_TYPE) === 'RCAG' ? text(row.ARTCC_OR_FSS_ID) : text(row.FACILITY);
        const facilityName = center ? unique(centers.has(facilityId) ? centers : centerFacilities, facilityId)
            : (type === 'CLEARANCE' && text(row.FACILITY_TYPE).startsWith('ATCT')
                ? unique(towerCalls, providerKey(row)) : unique(approachCalls, providerKey(row))) || text(row.FAC_NAME);
        return { ...(facilityId ? { facilityId } : {}), ...(facilityName ? { facilityName } : {}) };
    };
}

/** FRQ identifies the serviced facility, which may differ from the transmitting facility. */
export function airportFrequencyIndex(airports: CsvRecord[], rows: CsvRecord[],
    exclude: (row: CsvRecord, reason: string) => void = () => {}): Map<string, AirportFrequency[]> {
    const byIdent = new Map<string, CsvRecord[]>();
    for (const airport of airports) {
        const id = text(airport.ARPT_ID);
        if (!id) continue;
        const key = identity(id, text(airport.STATE_CODE), text(airport.COUNTRY_CODE));
        byIdent.set(key, [...(byIdent.get(key) || []), airport]);
    }
    const result = new Map<string, AirportFrequency[]>();
    const names = facilityNames(airports, rows);
    for (const row of rows) {
        const use = text(row.FREQ_USE).toUpperCase();
        // Retain combined source rows as one record so FRQ coverage accounting
        // remains one source row per exported or excluded record.
        const approach = /(?:^|\s)APCH\/[PS](?:\s|$)/.test(use);
        const departure = /(?:^|\s)DEP\/[PS](?:\s|$)/.test(use);
        const type: Service | undefined = /\bD-ATIS\b/.test(use) ? 'D-ATIS'
            : /\bATIS\b/.test(use) ? 'ATIS'
            : row.FACILITY_TYPE === 'ASOS_AWOS' && /\bAWOS\b/.test(use) ? 'AWOS'
            : row.FACILITY_TYPE === 'ASOS_AWOS' && /\bASOS\b/.test(use) ? 'ASOS'
            : /^LCL\/[PS](?:\s|$)/.test(use) ? 'TOWER'
            : /^GND\/[PS](?:\s|$)/.test(use) ? 'GROUND'
            : use === 'CTAF' ? 'CTAF'
            : /^CD(?:\/[PS](?:\s|$)| PRE (?:TAXI|DEP) CLNC$)/.test(use) ? 'CLEARANCE'
            : (approach && departure) || /^APCH\/DEP\/[PS](?:\s|$)/.test(use) ? 'APPROACH/DEPARTURE'
            : approach ? 'APPROACH'
            : departure ? 'DEPARTURE'
            : ['RCAG', 'ARTCC'].includes(text(row.FACILITY_TYPE)) ? 'CENTER' : undefined;
        const raw = text(row.FREQ);
        const frequencyMHz = Number(raw);
        if (!type || !/^\d+(?:\.\d+)?$/.test(raw) || frequencyMHz < 100 || frequencyMHz >= 400) {
            exclude(row, !type ? 'service-outside-airport-projection' : 'unsupported-frequency'); continue;
        }
        const candidates = (byIdent.get(identity(text(row.SERVICED_FACILITY),
            text(row.SERVICED_STATE), text(row.SERVICED_COUNTRY))) || [])
            .filter(airport => type === 'AWOS' || type === 'ASOS' ||
                SITE_TYPES[text(airport.SITE_TYPE_CODE)] === text(row.SERVICED_SITE_TYPE));
        // Never borrow a same-named NAVAID, another state's airport, or an ambiguous facility.
        if (candidates.length !== 1) { exclude(row, 'unavailable-or-ambiguous-airport'); continue; }
        const airport = candidates[0];
        const key = `${text(airport.SITE_NO)}:${text(airport.SITE_TYPE_CODE)}`;
        const frequency: AirportFrequency = { type, frequencyMHz, use, ...names(row, type),
            ...(text(row.SECTORIZATION) ? { sector: text(row.SECTORIZATION) } : {}),
            ...(text(row.TOWER_HRS) ? { hours: text(row.TOWER_HRS) } : {}),
            ...(text(row.REMARK) ? { remarks: text(row.REMARK) } : {}) };
        const frequencies = result.get(key) || [];
        if (!frequencies.some(existing => JSON.stringify(existing) === JSON.stringify(frequency))) frequencies.push(frequency);
        else exclude(row, 'duplicate-service');
        result.set(key, frequencies);
    }
    return result;
}
