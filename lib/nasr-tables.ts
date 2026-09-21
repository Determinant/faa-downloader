import { parseCsvRecords, type CsvRecord } from './csv.ts';
import type { NasrInput } from './nasr.ts';

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
    const dates = new Set(Object.values(tables).flatMap(rows => rows.map(row => row.EFF_DATE.trim())));
    if (dates.has('')) throw new Error('NASR record has a missing or mismatched effective date');
    if (dates.size !== 1) throw new Error(`NASR inputs must have one effective date; found ${[...dates].join(', ')}`);
    const date = [...dates][0].replaceAll('/', '-'), parsed = new Date(`${date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
        throw new Error(`Unexpected NASR effective date: ${date}`);
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
