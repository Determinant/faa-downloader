export type Coordinate = [number, number];
type Fix = { ident: string; coordinate: Coordinate; role?: 'IAF' | 'IF' | 'FAF' | 'MAP' };
type Reference = { id: string; ident: string; type: 'navaid' | 'localizer'; coordinate?: Coordinate; dmeCoordinate?: Coordinate; declination?: number };
export type CodedContinuation = { number: string; application: string; raw: string;
    services?: { authorization: string; name: string }[] };
export type CodedLeg = { path: string; id: string; reference?: Reference; radial?: number; rhoNm?: number;
    rnpNm?: number; speed?: { knots: number; restriction: string }; verticalAngle?: number;
    transitionAltitude?: string; turnDirectionValid?: boolean; gnssFms?: string; qualifiers?: string;
    continuations?: CodedContinuation[];
    altitude?: { restriction: string; first: string; second: string }; waypointDescriptor: string;
    fix?: Fix; sourceFix?: { id: string; ident: string }; missed?: boolean; turn?: 'L' | 'R'; magneticCourse?: number; trueCourse?: number; distance?: number; holdMinutes?: number; center?: Coordinate; radiusNm?: number };
export type CodedProcedure = {
    id: string; airport: string; ident: string; kind: 'departure' | 'arrival' | 'approach';
    magneticVariation?: number;
    runways?: { ident: string; coordinate: Coordinate }[];
    branches: { id: string; routeType: string; transition: string; legs: CodedLeg[] }[];
};
export type CifpDiagnostic = { procedureId: string; legId: string; code: 'unresolved-fix' | 'unresolved-reference' | 'unresolved-arc-center'; reference: string };
export const CIFP_SOURCE = 'https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/cifp/';

/** Decode PD/PE/PF and heliport equivalents once, using the same scoped reference index. */
export function parseCifpProcedures(input: string, effectiveDate: string) {
    const lines = input.split(/\r?\n/);
    const diagnostics: CifpDiagnostic[] = [];
    const sourceRecords = { departure: 0, arrival: 0, approach: 0 };
    let continuationRecords = 0;
    const epoch = Date.UTC(2020, 0, 2), period = 28 * 86400000;
    const date = Date.parse(effectiveDate), year = new Date(date).getUTCFullYear();
    const first = epoch + Math.ceil((Date.UTC(year, 0, 1) - epoch) / period) * period;
    const index = (date - first) / period + 1;
    const cycle = String(year).slice(-2) + String(index).padStart(2, '0');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) || !Number.isInteger(index) || !lines[0]?.startsWith('HDR01') || lines[0].slice(35, 39) !== cycle) {
        throw new Error(`CIFP header does not match effective date ${effectiveDate}`);
    }
    for (const [i, line] of lines.entries()) {
        if (line && line.length !== 132) throw new Error(`CIFP record on line ${i + 1} must contain 132 characters`);
    }
    const fixes = new Map<string, Coordinate>();
    const dmeCenters = new Map<string, Coordinate>();
    const airportVariations = new Map<string, number>();
    const airportRunways = new Map<string, { id: string; ident: string; coordinate: Coordinate }[]>();
    const references = new Map<string, Reference>();
    const localizerDme = new Map<string, Coordinate | null>();
    const referenceRecords = new Map<string, string>();
    const ambiguousReferences = new Set<string>();
    const variation = (field: string) => /^[EW]\d{4}$/.test(field) ? Number(field.slice(1)) / 10 * (field[0] === 'W' ? -1 : 1) : undefined;
    const key = (section: string, region: string, ident: string, airport: string) =>
        [section.trim(), region, ident.trim(), ['P', 'H'].includes(section[0]) ? airport : ''].join(':');
    for (const line of lines) {
        if (line[0] !== 'S' || !['0', '1'].includes(line[21])) continue;
        const section = ['P', 'H'].includes(line[4]) ? `${line[4]}${line[12]}` : line.slice(4, 6).trim();
        const airport = line.slice(6, 10).trim();
        if (['PA', 'HA'].includes(section) && /^(?:[EW]\d{4}|T0000)$/.test(line.slice(51, 56))) {
            airportVariations.set(airport, Number(line.slice(52, 56)) / 10 * (line[51] === 'W' ? -1 : 1));
        }
        if (!['PA', 'HA', 'PC', 'HC', 'PG', 'EA', 'D', 'DB', 'PN', 'PI'].includes(section)) continue;
        // AF arcs use the DME/TACAN antenna, which may be offset from its VOR.
        const dme = section === 'D' ? coordinates(line.slice(55, 64), line.slice(64, 74)) : undefined;
        // DME/TACAN-only stations leave the VOR position blank.
        const coordinate = coordinates(line.slice(32, 41), line.slice(41, 51)) ?? dme;
        const region = ['PA', 'HA', 'PG', 'PI'].includes(section) ? line.slice(10, 12) : line.slice(19, 21);
        const ident = ['PA', 'HA'].includes(section) ? airport : line.slice(13, section === 'PI' ? 17 : 18).trim();
        const fixKey = key(section, region, ident, airport);
        const signature = JSON.stringify([coordinate, dme, section === 'PI' ? line.slice(90, 95) : line.slice(74, 79)]);
        if (referenceRecords.has(fixKey) && referenceRecords.get(fixKey) !== signature) ambiguousReferences.add(fixKey);
        referenceRecords.set(fixKey, signature);
        // ILS DME antennas are separate airport-associated D records. Match the
        // airport, ICAO region and identifier; never substitute the LOC antenna.
        if (section === 'D' && airport && line[28] === 'I' && dme) {
            const id = key('PI', region, ident, airport), previous = localizerDme.get(id);
            localizerDme.set(id, previous === undefined || previous && previous[0] === dme[0] && previous[1] === dme[1] ? dme : null);
        }
        // Identical source definitions are harmless. Conflicts stay unresolved
        // for every referencing leg, independent of source record order.
        if (ambiguousReferences.has(fixKey)) {
            fixes.delete(fixKey); dmeCenters.delete(fixKey); references.delete(fixKey);
            continue;
        }
        if (coordinate) fixes.set(fixKey, coordinate);
        if (coordinate && section === 'PG') {
            const runways = airportRunways.get(airport) ?? [];
            if (!runways.some(runway => runway.id === fixKey)) runways.push({ id: fixKey, ident, coordinate });
            airportRunways.set(airport, runways);
        }
        if (dme) dmeCenters.set(fixKey, dme);
        if (['D', 'DB', 'PN', 'PI'].includes(section)) {
            const declination = variation(section === 'PI' ? line.slice(90, 95) : line.slice(74, 79));
            references.set(fixKey, { id: fixKey, ident, type: section === 'PI' ? 'localizer' : 'navaid',
                ...(coordinate ? { coordinate } : {}), ...(dme ? { dmeCoordinate: dme } : {}),
                ...(declination !== undefined ? { declination } : {}) });
        }
    }
    for (const reference of references.values()) if (reference.type === 'localizer') {
        const dme = localizerDme.get(reference.id);
        if (dme) reference.dmeCoordinate = dme;
    }
    const groups = new Map<string, { airport: string; ident: string; kind: CodedProcedure['kind']; routes: Map<string, string[]> }>();
    const recordKeys = new Set<string>();
    const primaryRecords = new Map<string, string>();
    const continuations = new Map<string, CodedContinuation[]>();
    for (const [lineIndex, line] of lines.entries()) {
        if (line[0] !== 'S' || !['P', 'H'].includes(line[4]) || !['D', 'E', 'F'].includes(line[12])) continue;
        const kind: CodedProcedure['kind'] = line[12] === 'D' ? 'departure' : line[12] === 'E' ? 'arrival' : 'approach';
        const airport = line.slice(6, 10).trim(), ident = line.slice(13, 19).trim();
        const id = kind === 'approach' ? `${airport}:${ident}` : `${airport}:${kind}:${ident}`;
        const recordKey = `${id}:${line[19]}:${line.slice(20, 25)}:${line.slice(26, 29)}`;
        if (!['0', '1'].includes(line[38])) {
            if (!/^[2-9A-Z]$/.test(line[38])) throw new Error(`Invalid CIFP continuation: ${recordKey}`);
            continuationRecords++;
            const records = continuations.get(recordKey) ?? [];
            if (records.some(record => record.number === line[38])) throw new Error(`Duplicate CIFP continuation on line ${lineIndex + 1}: ${recordKey}`);
            records.push({ number: line[38], application: line[39], raw: line,
                ...(line[39] === 'W' ? { services: [40, 51, 62].map(start => ({
                    authorization: line[start].trim(), name: line.slice(start + 1, start + 11).trim()
                })) } : {}) });
            continuations.set(recordKey, records);
            continue;
        }
        if (!airport || !ident || !line[19].trim() || !/^\d{3}$/.test(line.slice(26, 29))) {
            throw new Error(`Invalid CIFP procedure identity or sequence: ${recordKey}`);
        }
        if (recordKeys.has(recordKey)) throw new Error(`Duplicate CIFP procedure sequence: ${recordKey}`);
        recordKeys.add(recordKey);
        primaryRecords.set(recordKey, line);
        sourceRecords[kind]++;
        let group = groups.get(id);
        if (!group) { group = { airport, ident, kind, routes: new Map() }; groups.set(id, group); }
        const route = `${line[19]}:${line.slice(20, 25).trim()}`;
        const records = group.routes.get(route) ?? [];
        records.push(line); group.routes.set(route, records);
    }
    for (const [recordKey, records] of continuations) {
        if (!recordKeys.has(recordKey)) throw new Error(`Orphan CIFP continuation: ${recordKey}`);
        const primary = primaryRecords.get(recordKey)!;
        if (primary[38] !== '1' || records.some(record => record.raw.slice(29, 38) !== primary.slice(29, 38))) {
            throw new Error(`CIFP continuation does not match its primary record: ${recordKey}`);
        }
        records.sort((a, b) => a.number.localeCompare(b.number));
    }
    for (const [key, primary] of primaryRecords) if (primary[38] === '1' && !continuations.has(key)) {
        throw new Error(`Missing CIFP continuation: ${key}`);
    }
    const procedures: CodedProcedure[] = [];
    for (const [id, group] of groups) {
        const lookup = (line: string, start: number, regionStart: number, sectionStart: number) => {
            const section = line.slice(sectionStart, sectionStart + 2).trim();
            const region = line.slice(regionStart, regionStart + 2), ident = line.slice(start, start + 5);
            // Some FAA approaches reference PN while publishing the station as DB.
            return fixes.get(key(section, region, ident, group.airport)) ??
                (section === 'PN' ? fixes.get(key('DB', region, ident, '')) : undefined);
        };
        const legs = (records: string[]): CodedLeg[] => {
            let missed = false;
            return records.sort((a, b) => Number(a.slice(26, 29)) - Number(b.slice(26, 29))).map(line => {
                if (group.kind === 'approach' && line[41] === 'M') missed = true;
                const coordinate = lookup(line, 29, 34, 36);
                const role = group.kind === 'approach' ? ({ A: 'IAF', B: 'IF', C: 'IAF', D: 'IAF', I: 'IF', F: 'FAF', M: 'MAP' } as const)[line[42]] : undefined;
                const fix: Fix | undefined = coordinate ? { ident: line.slice(29, 34).trim(), coordinate, ...(role ? { role } : {}) } : undefined;
                const pathCode = line.slice(47, 49);
                const legId = `${line[19]}:${line.slice(20, 25).trim()}:${line.slice(26, 29)}`;
                if (!/^[A-Z]{2}$/.test(pathCode)) throw new Error(`Invalid CIFP path: ${id} ${legId}`);
                const sourceFix = line.slice(29, 34).trim() ? {
                    id: key(line.slice(36, 38), line.slice(34, 36), line.slice(29, 34), group.airport),
                    ident: line.slice(29, 34).trim()
                } : undefined;
                const issue = (code: CifpDiagnostic['code'], reference: string) => diagnostics.push({ procedureId: id, legId, code, reference });
                if (sourceFix && !coordinate) issue('unresolved-fix', sourceFix.id);
                const referenceIdent = line.slice(50, 54).trim();
                const referenceKey = key(line.slice(78, 80), line.slice(54, 56), referenceIdent, group.airport);
                const reference = referenceIdent ? references.get(referenceKey) ??
                    (line.slice(78, 80) === 'PN' ? references.get(key('DB', line.slice(54, 56), referenceIdent, '')) : undefined) ?? { id: referenceKey, ident: referenceIdent,
                    type: line.slice(78, 80) === 'PI' ? 'localizer' as const : 'navaid' as const } : undefined;
                const radialValue = decimalField(line.slice(62, 66), `${id} ${legId} theta`);
                const radial = radialValue === undefined ? undefined : radialValue % 360;
                const rhoNm = decimalField(line.slice(66, 70), `${id} ${legId} rho`);
                if (reference && !reference.coordinate) issue('unresolved-reference', reference.id);
                const first = altitudeField(line.slice(84, 89), `${id} ${legId}`), second = altitudeField(line.slice(89, 94), `${id} ${legId}`);
                // AF: recommended navaid (51–56, 79–80) and rho (67–70, tenths NM).
                // RF instead refers to a center fix (107–116).
                const center = pathCode === 'RF' ? lookup(line, 106, 112, 114)
                    : pathCode === 'AF' ? dmeCenters.get(key(line.slice(78, 80), line.slice(54, 56), line.slice(50, 54), group.airport)) : undefined;
                if (['AF', 'RF'].includes(pathCode) && !center) issue('unresolved-arc-center', pathCode === 'AF' ? referenceKey : key(line.slice(114, 116), line.slice(112, 114), line.slice(106, 111), group.airport));
                const arcRadius = scaledField(line.slice(56, 62), 1000, `${id} ${legId} arc radius`);
                const radiusNm = pathCode === 'AF' ? rhoNm : pathCode === 'RF' ? arcRadius : undefined;
                const rnp = line.slice(44, 47);
                if (rnp.trim() && !/^\d{3}$/.test(rnp)) throw new Error(`Invalid CIFP RNP: ${id} ${legId}`);
                const rnpNm = rnp.trim() ? Number(rnp.slice(0, 2)) / 10 ** Number(rnp[2]) : undefined;
                const speed = scaledField(line.slice(99, 102), 1, `${id} ${legId} speed`);
                const vertical = line.slice(102, 106);
                if (vertical.trim() && !/^[ +\-]\d{3}$/.test(vertical)) throw new Error(`Invalid CIFP vertical angle: ${id} ${legId}`);
                const verticalAngle = vertical.trim() ? Number(vertical) / 100 : undefined;
                const transitionAltitude = altitudeField(line.slice(94, 99), `${id} ${legId} transition altitude`);
                const extensions = continuations.get(`${id}:${line[19]}:${line.slice(20, 25)}:${line.slice(26, 29)}`);
                const magnetic = /^\d{3}T$/.test(line.slice(70, 74)) ? undefined : decimalField(line.slice(70, 74), `${id} ${legId} course`);
                const trueCourse = /^\d{3}T$/.test(line.slice(70, 74)) ? Number(line.slice(70, 73)) : undefined;
                const timed = /^T\d{3}$/.test(line.slice(74, 78));
                if (timed && !['HA', 'HF', 'HM'].includes(pathCode)) throw new Error(`Timed distance on non-hold: ${id} ${legId}`);
                const distance = timed ? undefined : decimalField(line.slice(74, 78), `${id} ${legId} distance`);
                // Hx uses the course field as INBOUND course, and Tnnn as minutes/tenths.
                const holdMinutes = ['HA', 'HF', 'HM'].includes(pathCode) && /^T\d{3}$/.test(line.slice(74, 78))
                    ? Number(line.slice(75, 78)) / 10 : 0;
                return { path: pathCode, id: legId,
                    ...(rnpNm !== undefined ? { rnpNm } : {}),
                    ...(speed !== undefined ? { speed: { knots: speed, restriction: line[117].trim() } } : {}),
                    ...(verticalAngle !== undefined ? { verticalAngle } : {}),
                    ...(transitionAltitude ? { transitionAltitude } : {}),
                    ...(line[49].trim() ? { turnDirectionValid: line[49] === 'Y' } : {}),
                    ...(line[116].trim() ? { gnssFms: line[116] } : {}),
                    ...(line.slice(118, 120).trim() ? { qualifiers: line.slice(118, 120) } : {}),
                    ...(extensions ? { continuations: extensions } : {}),
                    waypointDescriptor: line.slice(39, 43), ...(reference ? { reference } : {}),
                    ...(radial !== undefined ? { radial } : {}), ...(rhoNm !== undefined ? { rhoNm } : {}),
                    ...(first || second ? { altitude: { restriction: line[82].trim(), first, second } } : {}),
                    ...(fix ? { fix } : {}), ...(sourceFix && !fix ? { sourceFix } : {}), ...(missed ? { missed } : {}),
                    ...(['L', 'R'].includes(line[43]) ? { turn: line[43] as 'L' | 'R' } : {}),
                    ...(magnetic !== undefined ? { magneticCourse: magnetic % 360 } : {}),
                    ...(trueCourse !== undefined ? { trueCourse: trueCourse % 360 } : {}), ...(holdMinutes > 0 ? { holdMinutes } : {}),
                    ...(distance > 0 ? { distance } : {}), ...(center ? { center } : {}), ...(radiusNm > 0 ? { radiusNm } : {}) };
            });
        };
        const magneticVariation = airportVariations.get(group.airport);
        procedures.push({ id, airport: group.airport, ident: group.ident, kind: group.kind,
            ...(magneticVariation !== undefined ? { magneticVariation } : {}),
            ...(group.kind !== 'approach' && airportRunways.has(group.airport) ? { runways: airportRunways.get(group.airport)!
                .filter(r => fixes.has(r.id)).map(({ id: _id, ...runway }) => runway) } : {}),
            branches: [...group.routes].map(([route, records]) => ({
                id: route, routeType: route[0], transition: route.slice(2), legs: legs(records)
            })) });
    }
    return { effectiveDate, procedures, diagnostics, sourceRecords, continuationRecords,
        exportedContinuations: procedures.reduce((n, p) => n + p.branches.reduce((m, b) => m + b.legs.reduce((k, l) => k + (l.continuations?.length ?? 0), 0), 0), 0) };
}

function scaledField(value: string, divisor: number, label: string): number | undefined {
    if (!value.trim()) return undefined;
    if (!/^\d+$/.test(value)) throw new Error(`Invalid CIFP numeric field ${label}: ${value}`);
    return Number(value) / divisor;
}

function decimalField(value: string, label: string): number | undefined {
    if (!value.trim()) return undefined;
    if (!/^\d{4}$/.test(value)) throw new Error(`Invalid CIFP numeric field ${label}: ${value}`);
    return Number(value) / 10;
}

function altitudeField(value: string, label: string): string {
    const field = value.trim();
    if (!/^(?:\d{5}|-\d{4}|FL\d{3}|)$/.test(field)) throw new Error(`Invalid CIFP altitude ${label}: ${value}`);
    return field;
}

function coordinates(latitude: string, longitude: string): Coordinate | undefined {
    if (!latitude.trim() && !longitude.trim()) return undefined;
    if (!/^[NS]\d{8}$/.test(latitude) || !/^[EW]\d{9}$/.test(longitude)) {
        throw new Error(`Invalid CIFP coordinates: ${latitude} ${longitude}`);
    }
    const angle = (value: string, degrees: number, limit: number) => {
        const whole = Number(value.slice(1, degrees + 1)), minutes = Number(value.slice(degrees + 1, degrees + 3));
        const hundredths = Number(value.slice(degrees + 3));
        if (whole > limit || minutes >= 60 || hundredths >= 6000 || (whole === limit && (minutes || hundredths))) {
            throw new Error(`Invalid CIFP coordinate: ${value}`);
        }
        const result = whole + minutes / 60 + hundredths / 360000;
        return result * ('SW'.includes(value[0]) ? -1 : 1);
    };
    return [angle(longitude, 3, 180), angle(latitude, 2, 90)];
}
