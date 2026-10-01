import { parseCsvRecords, type CsvRecord } from './csv.ts';
import type { NasrInput } from './nasr.ts';
import { nasrGroupEffectiveDate } from './nasr-cycle.ts';

const definitions = {
    airports: ['APT_BASE', ['SITE_NO', 'SITE_TYPE_CODE', 'ARPT_ID', 'LAT_DECIMAL', 'LONG_DECIMAL']],
    runways: ['APT_RWY', ['SITE_NO', 'SITE_TYPE_CODE', 'RWY_ID']],
    runwayEnds: ['APT_RWY_END', ['SITE_NO', 'SITE_TYPE_CODE', 'RWY_ID', 'RWY_END_ID']],
    frequencies: ['FRQ', ['SERVICED_FACILITY', 'SERVICED_SITE_TYPE', 'SERVICED_STATE', 'SERVICED_COUNTRY', 'FACILITY_TYPE', 'FREQ', 'FREQ_USE']],
    fixes: ['FIX_BASE', ['FIX_ID', 'LAT_DECIMAL', 'LONG_DECIMAL', 'FIX_USE_CODE']],
    navaids: ['NAV_BASE', ['NAV_ID', 'NAV_TYPE', 'LAT_DECIMAL', 'LONG_DECIMAL']],
    airways: ['AWY_BASE', ['REGULATORY', 'AWY_LOCATION', 'AWY_ID']],
    airwaySegments: ['AWY_SEG_ALT', ['REGULATORY', 'AWY_LOCATION', 'AWY_ID', 'POINT_SEQ', 'FROM_POINT', 'FROM_PT_TYPE', 'TO_POINT']],
    preferredRoutes: ['PFR_BASE', ['ORIGIN_ID', 'DSTN_ID', 'PFR_TYPE_CODE', 'ROUTE_NO']],
    preferredRouteSegments: ['PFR_SEG', ['ORIGIN_ID', 'DSTN_ID', 'PFR_TYPE_CODE', 'ROUTE_NO', 'SEGMENT_SEQ', 'SEG_VALUE', 'SEG_TYPE']],
} as const satisfies Record<keyof NasrInput, readonly [string, readonly string[]]>;

export function readNasrTables(input: NasrInput) {
    const tables = Object.fromEntries((Object.keys(definitions) as (keyof NasrInput)[]).map(key => {
        const [name, columns] = definitions[key];
        const rows = parseCsvRecords(input[key], `${name}.csv`, ['EFF_DATE', ...columns]);
        if (!rows.length && key !== 'preferredRouteSegments') {
            throw new Error(`${name}.csv contains no ${key === 'frequencies' ? 'frequency records' : key === 'preferredRoutes' ? 'preferred routes' : 'records'}`);
        }
        return [key, rows];
    })) as Record<keyof NasrInput, CsvRecord[]>;
    // The 28-day groups identify the subscription cycle. Enroute tables retain
    // their 56-day edition during the intervening change-notice cycle.
    const currentTables = [tables.airports, tables.runways, tables.runwayEnds,
        tables.frequencies, tables.fixes, tables.navaids];
    const dates = new Set(currentTables.flatMap(rows => rows.map(row => row.EFF_DATE.trim())));
    if (dates.has('')) throw new Error('NASR record has a missing or mismatched effective date');
    if (dates.size !== 1) throw new Error(`NASR 28-day inputs must have one effective date; found ${[...dates].join(', ')}`);
    const date = [...dates][0].replaceAll('/', '-');
    for (const key of Object.keys(definitions) as (keyof NasrInput)[]) {
        const name = definitions[key][0];
        const expected = nasrGroupEffectiveDate(date, name.split('_')[0]).replaceAll('-', '/');
        for (const [index, row] of tables[key].entries()) {
            if (row.EFF_DATE.trim() !== expected) {
                throw new Error(`${name}.csv row ${index + 2} has a missing or mismatched effective date: ` +
                    `expected ${expected} for NASR cycle ${date}; found ${row.EFF_DATE.trim() || '(missing)'}`);
            }
        }
    }
    const excluded: { table: string; row: number; reason: string; record: CsvRecord }[] = [];
    const excludedRows = new Set<CsvRecord>();
    const locations = new Map(Object.entries(tables).flatMap(([key, rows]) => rows.map((row, i) =>
        [row, { table: definitions[key as keyof NasrInput][0], row: i + 2 }] as const)));
    const exclude = (record: CsvRecord, reason: string) => {
        if (excludedRows.has(record)) throw new Error('NASR row excluded twice');
        excludedRows.add(record);
        excluded.push({ ...locations.get(record)!, reason, record });
    };
    const coverage = () => Object.fromEntries(Object.entries(tables).map(([key, rows]) => {
        const omitted = rows.filter(row => excludedRows.has(row)).length;
        return [definitions[key as keyof NasrInput][0], { sourceRows: rows.length, exportedRows: rows.length - omitted, excludedRows: omitted }];
    }));
    return { tables, effectiveDate: date, exclude, excluded, coverage };
}
