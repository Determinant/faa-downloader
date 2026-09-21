import type { CsvRecord } from './csv.ts';

type Service = 'ATIS' | 'D-ATIS' | 'AWOS' | 'ASOS' | 'TOWER' | 'CTAF' | 'GROUND';
type AirportFrequency = {
    type: Service;
    frequencyMHz: number;
    use: string;
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
    for (const row of rows) {
        const use = text(row.FREQ_USE).toUpperCase();
        const type: Service | undefined = /\bD-ATIS\b/.test(use) ? 'D-ATIS'
            : /\bATIS\b/.test(use) ? 'ATIS'
            : row.FACILITY_TYPE === 'ASOS_AWOS' && /\bAWOS\b/.test(use) ? 'AWOS'
            : row.FACILITY_TYPE === 'ASOS_AWOS' && /\bASOS\b/.test(use) ? 'ASOS'
            : /^LCL\/[PS](?:\s|$)/.test(use) ? 'TOWER'
            : /^GND\/[PS](?:\s|$)/.test(use) ? 'GROUND'
            : use === 'CTAF' ? 'CTAF' : undefined;
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
        const frequency: AirportFrequency = { type, frequencyMHz, use,
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
