import { parseCsvRecords, parseCsvRows, type CsvRecord } from './csv.ts';

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
    const excluded: { group: 'DP' | 'STAR'; table: string; reason: 'unassigned-computer-code'; record: CsvRecord }[] = [];
    const diagnostics: { procedureId: string; route?: string; code: 'no-routes' | 'unassociated-body' | 'discontinuity' | 'airport-not-in-base' }[] = [];
    const sourceRows: Record<string, number> = {};
    for (const group of ['DP', 'STAR'] as const) {
        const departure = group === 'DP';
        const read = (value: string, table: string) => {
            const label = `${group}_${table}.csv`;
            const requiredHeaders = ['EFF_DATE', `${group}_COMPUTER_CODE`, 'ARTCC', ...(table === 'BASE'
                ? [departure ? 'DP_NAME' : 'ARRIVAL_NAME', 'AMENDMENT_NO', 'SERVED_ARPT']
                : table === 'APT' ? ['BODY_NAME', 'BODY_SEQ', 'ARPT_ID', 'RWY_END_ID']
                : ['ROUTE_PORTION_TYPE', 'ROUTE_NAME', 'BODY_SEQ', 'TRANSITION_COMPUTER_CODE', 'POINT_SEQ', 'POINT', 'POINT_TYPE', 'ICAO_REGION_CODE', 'NEXT_POINT'])];
            const headers = parseCsvRows(value)[0]?.map(field => field.trim()) ?? [];
            const missing = requiredHeaders.filter(field => !headers.includes(field));
            if (missing.length) throw new Error(`${label} missing columns: ${missing.join(', ')}`);
            const rows = parseCsvRecords(value, label);
            sourceRows[`${group}_${table}`] = rows.length;
            if (table === 'BASE' && rows.length === 0) throw new Error(`${group}_BASE.csv contains no procedures`);
            for (const row of rows) {
                if (row.EFF_DATE?.replaceAll('/', '-') !== effectiveDate) {
                    throw new Error(`${group}_${table}: mismatched effective date`);
                }
            }
            // Keep uncoded source records in a ledger without inventing filing identities.
            return rows.filter(row => {
                if (row[`${group}_COMPUTER_CODE`]?.trim() !== 'NOT ASSIGNED') return true;
                excluded.push({ group, table, reason: 'unassigned-computer-code', record: row });
                return false;
            });
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
                airports: [...new Set(required(row, 'SERVED_ARPT').split(/[,\s]+/).filter(Boolean))],
                routes: []
            };
            if (byCode.has(key(row))) throw new Error(`Duplicate procedure: ${key(row)}`);
            byCode.set(key(row), procedure);
            procedures.push(procedure);
        }
        const associations = new Map<string, Route['airports']>();
        const usedAssociations = new Set<string>();
        for (const row of airports) {
            if (!byCode.has(key(row))) throw new Error(`Procedure airport has no parent: ${key(row)}`);
            const body = `${key(row)}:${required(row, 'BODY_NAME')}:${positive(row, 'BODY_SEQ')}`;
            const values = associations.get(body) ?? [];
            const runway = row.RWY_END_ID?.trim();
            const ident = required(row, 'ARPT_ID');
            if (!byCode.get(key(row))!.airports.includes(ident)) diagnostics.push({ procedureId: byCode.get(key(row))!.id, route: `${row.BODY_NAME}:${ident}`, code: 'airport-not-in-base' });
            if (values.some(value => value.ident === ident && value.runway === runway)) {
                throw new Error(`Duplicate procedure airport association: ${body} ${ident} ${runway ?? ''}`);
            }
            values.push({ ident, ...(runway ? { runway } : {}) });
            associations.set(body, values);
        }
        const paths = new Map<string, Route>();
        const bodyPaths = new Map<string, string>();
        for (const row of routes) {
            const parent = byCode.get(key(row));
            if (!parent) throw new Error(`Procedure route has no parent: ${key(row)}`);
            const portion = required(row, 'ROUTE_PORTION_TYPE');
            if (portion !== 'BODY' && portion !== 'TRANSITION') throw new Error(`Unknown procedure portion: ${portion}`);
            const name = required(row, 'ROUTE_NAME');
            const bodySequence = positive(row, 'BODY_SEQ');
            const transition = row.TRANSITION_COMPUTER_CODE?.trim();
            const pathKey = `${key(row)}:${portion}:${name}:${bodySequence}:${transition ?? ''}`;
            const bodyKey = `${key(row)}:${name}:${bodySequence}`;
            if (portion === 'BODY') {
                if (bodyPaths.has(bodyKey) && bodyPaths.get(bodyKey) !== pathKey) throw new Error(`Ambiguous procedure body: ${bodyKey}`);
                bodyPaths.set(bodyKey, pathKey);
            }
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
                if (portion === 'BODY') usedAssociations.add(`${key(row)}:${name}:${bodySequence}`);
                paths.set(pathKey, route);
                parent.routes.push(route);
            }
            const icaoRegion = row.ICAO_REGION_CODE?.trim();
            const next = row.NEXT_POINT?.trim();
            route.points.push({ sequence: positive(row, 'POINT_SEQ'), ident: required(row, 'POINT'),
                type: required(row, 'POINT_TYPE'), ...(icaoRegion ? { icaoRegion } : {}), ...(next ? { next } : {}) });
        }
        for (const association of associations.keys()) {
            if (!usedAssociations.has(association)) throw new Error(`Procedure airport association has no route body: ${association}`);
        }
        for (const procedure of byCode.values()) {
            if (!procedure.routes.length) diagnostics.push({ procedureId: procedure.id, code: 'no-routes' });
            for (const route of procedure.routes) {
                route.points.sort((a, b) => a.sequence - b.sequence);
                if (route.kind === 'body' && !route.airports.length) diagnostics.push({ procedureId: procedure.id, route: route.name, code: 'unassociated-body' });
                if (route.points.some((point, index) => index + 1 < route.points.length && point.next !== route.points[index + 1].ident)) {
                    diagnostics.push({ procedureId: procedure.id, route: route.name, code: 'discontinuity' });
                }
                if (new Set(route.points.map(point => point.sequence)).size !== route.points.length) {
                    throw new Error(`Duplicate procedure point sequence: ${procedure.ident} ${route.name}`);
                }
            }
        }
    }
    return { type: 'ZLayerTerminalProcedures' as const,
        metadata: { effectiveDate, source: 'FAA 28-day NASR DP/STAR subscription' }, procedures, excluded, diagnostics, sourceRows };
}

function required(row: CsvRecord, field: string): string {
    const value = row[field]?.trim();
    if (!value) throw new Error(`Missing procedure field: ${field}`);
    return value;
}

function positive(row: CsvRecord, field: string): number {
    const raw = required(row, field), value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid procedure field: ${field}`);
    return value;
}
