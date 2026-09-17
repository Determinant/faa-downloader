import { parseCsvRecords, type CsvRecord } from './csv.ts';

export type TerminalProcedureInput = {
    departures: string;
    departureAirports: string;
    departureRoutes: string;
    arrivals: string;
    arrivalAirports: string;
    arrivalRoutes: string;
};

type Point = { sequence: number; ident: string; type: string; icaoRegion?: string; next?: string };
type Route = {
    name: string;
    kind: 'body' | 'transition';
    bodySequence: number;
    transition?: string;
    airports: { ident: string; runway?: string }[];
    points: Point[];
};
type Procedure = {
    id: string;
    ident: string;
    kind: 'departure' | 'arrival';
    name: string;
    computerCode: string;
    airports: string[];
    routes: Route[];
};

/** NASR supplies waypoint sequences, not ARINC leg paths or altitude/speed constraints. */
export function buildTerminalProcedures(input: TerminalProcedureInput, effectiveDate: string) {
    const procedures: Procedure[] = [];
    for (const group of ['DP', 'STAR'] as const) {
        const departure = group === 'DP';
        const read = (value: string, table: string) => {
            const rows = parseCsvRecords(value, `${group}_${table}.csv`);
            if (table === 'BASE' && rows.length === 0) throw new Error(`${group}_BASE.csv contains no procedures`);
            for (const row of rows) {
                if (row.EFF_DATE?.replaceAll('/', '-') !== effectiveDate) {
                    throw new Error(`${group}_${table}: mismatched effective date`);
                }
            }
            // Uncoded (often vector-only) departures cannot be resolved by a filed identifier.
            return rows.filter(row => row[`${group}_COMPUTER_CODE`]?.trim() !== 'NOT ASSIGNED');
        };
        const bases = read(departure ? input.departures : input.arrivals, 'BASE');
        const airports = read(departure ? input.departureAirports : input.arrivalAirports, 'APT');
        const routes = read(departure ? input.departureRoutes : input.arrivalRoutes, 'RTE');
        const key = (row: CsvRecord) => `${required(row, `${group}_COMPUTER_CODE`)}:${row.ARTCC?.trim() ?? ''}`;
        const byCode = new Map<string, Procedure>();
        for (const row of bases) {
            const computerCode = required(row, `${group}_COMPUTER_CODE`);
            const codes = computerCode.split('.');
            if (codes.length !== 2 || codes.some(code => !code)) throw new Error(`Invalid procedure code: ${computerCode}`);
            const procedure: Procedure = {
                id: `terminal:${group}:${key(row)}`,
                ident: codes[departure ? 0 : 1]!,
                kind: departure ? 'departure' : 'arrival',
                name: `${required(row, departure ? 'DP_NAME' : 'ARRIVAL_NAME')} ${required(row, 'AMENDMENT_NO')}`,
                computerCode,
                airports: required(row, 'SERVED_ARPT').split(/[,\s]+/).filter(Boolean),
                routes: []
            };
            if (byCode.has(key(row))) throw new Error(`Duplicate procedure: ${key(row)}`);
            byCode.set(key(row), procedure);
            procedures.push(procedure);
        }
        const associations = new Map<string, Route['airports']>();
        for (const row of airports) {
            if (!byCode.has(key(row))) throw new Error(`Procedure airport has no parent: ${key(row)}`);
            const body = `${key(row)}:${required(row, 'BODY_NAME')}:${positive(row, 'BODY_SEQ')}`;
            const values = associations.get(body) ?? [];
            const runway = row.RWY_END_ID?.trim();
            values.push({ ident: required(row, 'ARPT_ID'), ...(runway ? { runway } : {}) });
            associations.set(body, values);
        }
        const paths = new Map<string, Route>();
        for (const row of routes) {
            const parent = byCode.get(key(row));
            if (!parent) throw new Error(`Procedure route has no parent: ${key(row)}`);
            const portion = required(row, 'ROUTE_PORTION_TYPE');
            if (portion !== 'BODY' && portion !== 'TRANSITION') throw new Error(`Unknown procedure portion: ${portion}`);
            const name = required(row, 'ROUTE_NAME');
            const bodySequence = positive(row, 'BODY_SEQ');
            const transition = row.TRANSITION_COMPUTER_CODE?.trim();
            const pathKey = `${key(row)}:${portion}:${name}:${bodySequence}:${transition ?? ''}`;
            let route = paths.get(pathKey);
            if (!route) {
                route = {
                    name, kind: portion === 'BODY' ? 'body' : 'transition', bodySequence,
                    ...(transition ? { transition } : {}),
                    airports: portion === 'BODY' ? associations.get(`${key(row)}:${name}:${bodySequence}`) ?? [] : [],
                    points: []
                };
                // Some FAA bodies have no airport association. Preserve the empty
                // list; consumers must not interpret it as applying everywhere.
                paths.set(pathKey, route);
                parent.routes.push(route);
            }
            const icaoRegion = row.ICAO_REGION_CODE?.trim();
            const next = row.NEXT_POINT?.trim();
            route.points.push({ sequence: positive(row, 'POINT_SEQ'), ident: required(row, 'POINT'),
                type: required(row, 'POINT_TYPE'), ...(icaoRegion ? { icaoRegion } : {}), ...(next ? { next } : {}) });
        }
        for (const procedure of byCode.values()) {
            for (const route of procedure.routes) {
                route.points.sort((a, b) => a.sequence - b.sequence);
                if (new Set(route.points.map(point => point.sequence)).size !== route.points.length) {
                    throw new Error(`Duplicate procedure point sequence: ${procedure.ident} ${route.name}`);
                }
            }
        }
    }
    return { type: 'ZLayerTerminalProcedures' as const,
        metadata: { effectiveDate, source: 'FAA 28-day NASR DP/STAR subscription' }, procedures };
}

function required(row: CsvRecord, field: string): string {
    const value = row[field]?.trim();
    if (!value) throw new Error(`Missing procedure field: ${field}`);
    return value;
}

function positive(row: CsvRecord, field: string): number {
    const value = Number(required(row, field));
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid procedure field: ${field}`);
    return value;
}
