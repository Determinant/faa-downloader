import fs from 'node:fs/promises';
import path from 'node:path';
import { downloadFile } from './http-download.ts';
import { extractZipEntry, validateZipArchive } from './zip.ts';

type Coordinate = [number, number];
type Fix = { ident: string; coordinate: Coordinate; role?: 'IAF' | 'IF' | 'FAF' | 'MAP' };
type Leg = { path: string; fix?: Fix; missed?: boolean; turn?: 'L' | 'R'; magneticCourse?: number; trueCourse?: number; distance?: number; holdMinutes?: number; center?: Coordinate; radiusNm?: number };
type Procedure = { id: string; airport: string; ident: string; magneticVariation?: number; transitions: { id: string; legs: Leg[] }[]; final: Leg[] };
const SOURCE = 'https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/cifp/';

/** ARINC 424-18 PF primary records. Never merge like-named fixes across airports/regions. */
export function buildApproachRoutes(input: string, effectiveDate: string) {
    const lines = input.split(/\r?\n/);
    const epoch = Date.UTC(2020, 0, 2), period = 28 * 86400000;
    const date = Date.parse(effectiveDate), year = new Date(date).getUTCFullYear();
    const first = epoch + Math.ceil((Date.UTC(year, 0, 1) - epoch) / period) * period;
    const index = (date - first) / period + 1;
    const cycle = String(year).slice(-2) + String(index).padStart(2, '0');
    if (!Number.isInteger(index) || !lines[0]?.startsWith('HDR01') || lines[0].slice(35, 39) !== cycle) {
        throw new Error(`CIFP header does not match effective date ${effectiveDate}`);
    }
    for (const [i, line] of lines.entries()) {
        if (line && line.length !== 132) throw new Error(`CIFP record on line ${i + 1} must contain 132 characters`);
    }
    const fixes = new Map<string, Coordinate>();
    const dmeCenters = new Map<string, Coordinate>();
    const airportVariations = new Map<string, number>();
    const key = (section: string, region: string, ident: string, airport: string) =>
        [section.trim(), region, ident.trim(), section[0] === 'P' ? airport : ''].join(':');
    for (const line of lines) {
        if (line[0] !== 'S' || !['0', '1'].includes(line[21])) continue;
        const section = line[4] === 'P' ? `P${line[12]}` : line.slice(4, 6).trim();
        const airport = line.slice(6, 10).trim();
        if (section === 'PA' && /^(?:[EW]\d{4}|T0000)$/.test(line.slice(51, 56))) {
            airportVariations.set(airport, Number(line.slice(52, 56)) / 10 * (line[51] === 'W' ? -1 : 1));
        }
        if (!['PC', 'PG', 'EA', 'D', 'DB', 'PN'].includes(section)) continue;
        // AF arcs use the DME/TACAN antenna, which may be offset from its VOR.
        const dme = section === 'D' ? coordinates(line.slice(55, 64), line.slice(64, 74)) : undefined;
        // DME/TACAN-only stations leave the VOR position blank.
        const coordinate = coordinates(line.slice(32, 41), line.slice(41, 51)) ?? dme;
        const region = section === 'PG' ? line.slice(10, 12) : line.slice(19, 21);
        const fixKey = key(section, region, line.slice(13, 18), airport);
        if (coordinate) fixes.set(fixKey, coordinate);
        if (dme) dmeCenters.set(fixKey, dme);
    }
    const groups = new Map<string, { airport: string; ident: string; routes: Map<string, string[]> }>();
    for (const line of lines) {
        if (line[0] !== 'S' || line[4] !== 'P' || line[12] !== 'F' || !['0', '1'].includes(line[38])) continue;
        const airport = line.slice(6, 10).trim(), ident = line.slice(13, 19).trim(), id = `${airport}:${ident}`;
        let group = groups.get(id);
        if (!group) { group = { airport, ident, routes: new Map() }; groups.set(id, group); }
        const route = `${line[19]}:${line.slice(20, 25).trim()}`;
        const records = group.routes.get(route) ?? [];
        records.push(line); group.routes.set(route, records);
    }
    const procedures: Procedure[] = [];
    for (const [id, group] of groups) {
        const lookup = (line: string, start: number, regionStart: number, sectionStart: number) => {
            const section = line.slice(sectionStart, sectionStart + 2).trim();
            const region = line.slice(regionStart, regionStart + 2), ident = line.slice(start, start + 5);
            // Some FAA approaches reference PN while publishing the station as DB.
            return fixes.get(key(section, region, ident, group.airport)) ??
                (section === 'PN' ? fixes.get(key('DB', region, ident, '')) : undefined);
        };
        const legs = (records: string[]): Leg[] => {
            let missed = false;
            return records.sort((a, b) => Number(a.slice(26, 29)) - Number(b.slice(26, 29))).map(line => {
                if (line[41] === 'M') missed = true;
                const coordinate = lookup(line, 29, 34, 36);
                const role = ({ A: 'IAF', B: 'IF', C: 'IAF', D: 'IAF', I: 'IF', F: 'FAF', M: 'MAP' } as const)[line[42]];
                const fix: Fix | undefined = coordinate ? { ident: line.slice(29, 34).trim(), coordinate, ...(role ? { role } : {}) } : undefined;
                const pathCode = line.slice(47, 49);
                // AF: recommended navaid (51–56, 79–80) and rho (67–70, tenths NM).
                // RF instead refers to a center fix (107–116).
                const center = pathCode === 'RF' ? lookup(line, 106, 112, 114)
                    : pathCode === 'AF' ? dmeCenters.get(key(line.slice(78, 80), line.slice(54, 56), line.slice(50, 54), group.airport)) : undefined;
                const radiusNm = pathCode === 'AF' && /^\d{4}$/.test(line.slice(66, 70)) ? Number(line.slice(66, 70)) / 10 : 0;
                const magnetic = /^\d{4}$/.test(line.slice(70, 74)) ? Number(line.slice(70, 74)) / 10 : undefined;
                const trueCourse = /^\d{3}T$/.test(line.slice(70, 74)) ? Number(line.slice(70, 73)) : undefined;
                const distance = /^\d{4}$/.test(line.slice(74, 78)) ? Number(line.slice(74, 78)) / 10 : 0;
                // Hx uses the course field as INBOUND course, and Tnnn as minutes/tenths.
                const holdMinutes = ['HA', 'HF', 'HM'].includes(pathCode) && /^T\d{3}$/.test(line.slice(74, 78))
                    ? Number(line.slice(75, 78)) / 10 : 0;
                return { path: pathCode, ...(fix ? { fix } : {}), ...(missed ? { missed } : {}),
                    ...(['L', 'R'].includes(line[43]) ? { turn: line[43] as 'L' | 'R' } : {}),
                    ...(magnetic !== undefined ? { magneticCourse: magnetic % 360 } : {}),
                    ...(trueCourse !== undefined ? { trueCourse: trueCourse % 360 } : {}), ...(holdMinutes > 0 ? { holdMinutes } : {}),
                    ...(distance > 0 ? { distance } : {}), ...(center ? { center } : {}), ...(radiusNm > 0 ? { radiusNm } : {}) };
            });
        };
        const finals = [...group.routes].filter(([route]) => !route.startsWith('A:'));
        // Multiple main branches require an explicit choice we cannot infer from a chart title.
        if (finals.length !== 1) continue;
        const magneticVariation = airportVariations.get(group.airport);
        procedures.push({ id, airport: group.airport, ident: group.ident,
            ...(magneticVariation !== undefined ? { magneticVariation } : {}),
            transitions: [...group.routes].filter(([route]) => route.startsWith('A:')).map(([route, records]) => ({ id: route.slice(2), legs: legs(records) })),
            final: legs(finals[0][1]) });
    }
    if (!procedures.length) throw new Error('CIFP contains no approach routes');
    return { type: 'ZLayerApproachRoutes' as const, metadata: { effectiveDate, source: SOURCE }, procedures };
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

export async function loadApproachRoutes(effectiveDate: string, cacheDirectory: string, sourceDirectory?: string) {
    const local = sourceDirectory && path.join(sourceDirectory, 'FAACIFP18');
    if (local) {
        try { return buildApproachRoutes(await fs.readFile(local, 'utf8'), effectiveDate); }
        catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error; }
    }
    const filename = `CIFP_${effectiveDate.slice(2).replaceAll('-', '')}.zip`;
    const archive = path.join(cacheDirectory, filename), raw = path.join(cacheDirectory, 'FAACIFP18');
    await downloadFile(`https://aeronav.faa.gov/Upload_313-d/cifp/${filename}`, archive,
        { userAgent: 'faa-regs-approach-builder/1.0', validate: validateZipArchive });
    await extractZipEntry(archive, 'FAACIFP18', raw);
    return buildApproachRoutes(await fs.readFile(raw, 'utf8'), effectiveDate);
}
