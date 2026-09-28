import type { NasrFeatureCollection } from './nasr.ts';

/** Join FAA CIFP PG runway magnetic bearings to existing NASR ends, without estimating from identifiers. */
export function addCifpRunwayHeadings(airports: NasrFeatureCollection, input: string): number {
    const headings = new Map<string, number | null>();
    for (const line of input.split(/\r?\n/)) {
        if (line[0] !== 'S' || line[4] !== 'P' || line[12] !== 'G' || !['0', '1'].includes(line[21])) continue;
        if (line.length !== 132) throw new Error('CIFP runway record must contain 132 characters');
        const airport = line.slice(6, 10).trim(), runway = line.slice(13, 18).trim();
        const field = line.slice(27, 31);
        // Four digits encode tenths of a magnetic degree. Blank or true-designated fields are not magnetic bearings.
        const heading = /^\d{4}$/.test(field) && Number(field) <= 3600 ? Number(field) / 10 : null;
        // RW is a CIFP prefix, not part of the NASR end identifier. Preserve
        // suffixes (08G, 032, 18W, ...) and unprefixed names (N, NE, ...).
        const endId = runway.startsWith('RW') ? runway.slice(2) : runway;
        if (!airport || !endId) continue;
        const key = `${airport}:${endId}`;
        const previous = headings.get(key);
        headings.set(key, previous === undefined || previous === heading ? heading : null);
    }
    let count = 0;
    for (const airport of airports.features) {
        const properties = airport.properties;
        // CIFP uses the FAA identifier where the airport has no ICAO identifier.
        const airportId = properties.icaoId || properties.faaId;
        if (typeof airportId !== 'string' || !airportId || !Array.isArray(properties.runways)) continue;
        for (const runway of properties.runways) {
            if (!Array.isArray(runway.ends)) continue;
            for (const end of runway.ends) {
                const heading = headings.get(`${airportId}:${end.id}`);
                if (typeof heading !== 'number') continue;
                end.magneticHeadingDeg = heading;
                count++;
            }
        }
    }
    if (count) airports.metadata.source = 'FAA 28-day NASR subscription and CIFP';
    return count;
}
