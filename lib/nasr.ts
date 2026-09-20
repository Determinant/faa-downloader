import { parseCsvRecords, type CsvRecord } from './csv.ts';
import { airportFrequencyIndex } from './airport-frequencies.ts';

type Geometry = {
    type: 'Point';
    coordinates: [number, number];
};

export type NasrFeature = {
    type: 'Feature';
    id: string;
    geometry: Geometry;
    properties: Record<string, unknown>;
};

export type NasrFeatureCollection = {
    type: 'FeatureCollection';
    metadata: {
        effectiveDate: string;
        source: string;
    };
    features: NasrFeature[];
};

export type NasrInput = {
    airports: string;
    runways: string;
    runwayEnds: string;
    frequencies: string;
    fixes: string;
    navaids: string;
    airways: string;
    airwaySegments: string;
    preferredRoutes: string;
    preferredRouteSegments: string;
};

export type NasrProducts = {
    effectiveDate: string;
    airports: NasrFeatureCollection;
    fixes: NasrFeatureCollection;
    vfrWaypoints: NasrFeatureCollection;
    navaids: NasrFeatureCollection;
    airways: {
        type: 'ZLayerAirways';
        metadata: NasrFeatureCollection['metadata'];
        airways: Record<string, unknown>[];
    };
    preferredRoutes: {
        type: 'ZLayerPreferredRoutes';
        metadata: NasrFeatureCollection['metadata'];
        routes: Record<string, unknown>[];
    };
};

const NASR_SOURCE = 'FAA 28-day NASR subscription';

function present(value: string | undefined): string | undefined {
    const normalized = String(value || '').trim();
    return normalized || undefined;
}

function numberValue(value: string | undefined): number | undefined {
    const normalized = present(value);
    if (normalized === undefined) return undefined;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanFlag(value: string | undefined): boolean | undefined {
    const normalized = present(value)?.toUpperCase();
    if (normalized === 'Y') return true;
    if (normalized === 'N') return false;
    return undefined;
}

function stationDeclination(row: CsvRecord): number | undefined {
    if (!['VOR', 'VOR/DME', 'VORTAC'].includes(present(row.NAV_TYPE) || '')) return undefined;
    const degrees = numberValue(row.MAG_VARN);
    const hemisphere = present(row.MAG_VARN_HEMIS)?.toUpperCase();
    if (degrees === undefined || degrees < 0 || degrees > 180) return undefined;
    if (hemisphere === 'E') return degrees;
    if (hemisphere === 'W') return -degrees;
    return degrees === 0 && hemisphere === undefined ? 0 : undefined;
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function assertUniqueIds(label: string, ids: string[]): void {
    const seen = new Set<string>();
    for (const id of ids) {
        if (seen.has(id)) throw new Error(`${label} contains duplicate feature ID: ${id}`);
        seen.add(id);
    }
}

function effectiveDate(records: CsvRecord[][]): string {
    const values = new Set(
        records.flatMap(group => group.map(record => present(record.EFF_DATE)).filter(Boolean))
    );
    if (values.size !== 1) {
        throw new Error(`NASR inputs must have one effective date; found ${[...values].join(', ')}`);
    }
    const value = [...values][0];
    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(value)) {
        throw new Error(`Unexpected NASR effective date: ${value}`);
    }
    return value.replaceAll('/', '-');
}

function pointFeature(
    id: string,
    row: CsvRecord,
    properties: Record<string, unknown>
): NasrFeature | null {
    const latitude = numberValue(row.LAT_DECIMAL);
    const longitude = numberValue(row.LONG_DECIMAL);
    if (latitude === undefined || longitude === undefined) return null;
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;

    return {
        type: 'Feature',
        id,
        geometry: { type: 'Point', coordinates: [longitude, latitude] },
        properties: compactObject(properties)
    };
}

function collection(
    effective: string,
    features: NasrFeature[],
    label: string
): NasrFeatureCollection {
    assertUniqueIds(label, features.map(feature => feature.id));
    return {
        type: 'FeatureCollection',
        metadata: { effectiveDate: effective, source: NASR_SOURCE },
        features
    };
}

function normalizeAirways(
    airwayRows: CsvRecord[],
    segmentRows: CsvRecord[],
    effective: string
): NasrProducts['airways'] {
    const groupedSegments = new Map<string, CsvRecord[]>();
    for (const row of segmentRows) {
        const key = [row.REGULATORY, row.AWY_LOCATION, row.AWY_ID]
            .map(value => present(value) || '')
            .join(':');
        const group = groupedSegments.get(key) || [];
        group.push(row);
        groupedSegments.set(key, group);
    }

    const airways = airwayRows.map(row => {
        const location = present(row.AWY_LOCATION);
        const ident = present(row.AWY_ID);
        const regulatoryCode = present(row.REGULATORY);
        const key = [regulatoryCode || '', location || '', ident || ''].join(':');
        const segments = (groupedSegments.get(key) || [])
            .sort((left, right) => (numberValue(left.POINT_SEQ) || 0) - (numberValue(right.POINT_SEQ) || 0))
            .map(segment => compactObject({
                sequence: numberValue(segment.POINT_SEQ),
                from: present(segment.FROM_POINT),
                fromType: present(segment.FROM_PT_TYPE),
                to: present(segment.TO_POINT),
                gap: booleanFlag(segment.AWY_SEG_GAP_FLAG),
                magneticCourse: numberValue(segment.MAG_COURSE),
                oppositeMagneticCourse: numberValue(segment.OPP_MAG_COURSE),
                distanceNm: numberValue(segment.MAG_COURSE_DIST),
                meaFt: numberValue(segment.MIN_ENROUTE_ALT),
                oppositeMeaFt: numberValue(segment.MIN_ENROUTE_ALT_OPPOSITE),
                gpsMeaFt: numberValue(segment.GPS_MIN_ENROUTE_ALT),
                mocaFt: numberValue(segment.MIN_OBSTN_CLNC_ALT),
                maxAuthorizedAltitudeFt: numberValue(segment.MAX_AUTH_ALT),
                state: present(segment.STATE_CODE),
                country: present(segment.COUNTRY_CODE),
                icaoRegion: present(segment.ICAO_REGION_CODE),
                artcc: present(segment.ARTCC),
                remark: present(segment.REMARK)
            }));

        return compactObject({
            id: `airway:${regulatoryCode || 'unknown'}:${location || 'unknown'}:${ident || 'unknown'}`,
            ident,
            location,
            regulatory: booleanFlag(row.REGULATORY),
            updatedAt: present(row.UPDATE_DATE)?.replaceAll('/', '-'),
            points: present(row.AIRWAY_STRING)?.split(/\s+/),
            remark: present(row.REMARK),
            segments
        });
    });
    assertUniqueIds('airways', airways.map(airway => String(airway.id)));

    return {
        type: 'ZLayerAirways',
        metadata: { effectiveDate: effective, source: NASR_SOURCE },
        airways
    };
}

function preferredRouteKey(row: CsvRecord): string {
    const fields = ['ORIGIN_ID', 'DSTN_ID', 'PFR_TYPE_CODE', 'ROUTE_NO'];
    const values = fields.map(field => present(row[field]));
    if (values.some(value => value === undefined) || !/^[1-9]\d*$/.test(values[3])) {
        throw new Error(`PFR record has invalid route identity: ${values.join(':')}`);
    }
    return values.join(':');
}

function normalizePreferredRoutes(
    routeRows: CsvRecord[],
    segmentRows: CsvRecord[],
    effective: string
): NasrProducts['preferredRoutes'] {
    if (routeRows.length === 0) throw new Error('PFR_BASE.csv contains no preferred routes');
    const sourceDate = effective.replaceAll('-', '/');
    for (const rows of [routeRows, segmentRows]) {
        for (const row of rows) {
            if (present(row.EFF_DATE) !== sourceDate) {
                throw new Error('PFR record has a missing or mismatched effective date');
            }
        }
    }
    const keys = routeRows.map(preferredRouteKey);
    assertUniqueIds('preferred routes', keys);
    const routeKeys = new Set(keys);
    const groupedSegments = new Map<string, CsvRecord[]>();
    const segmentKeys = new Set<string>();
    for (const row of segmentRows) {
        const key = preferredRouteKey(row);
        if (!routeKeys.has(key)) throw new Error(`PFR segment has no parent route: ${key}`);
        const sequence = present(row.SEGMENT_SEQ);
        if (!sequence || !/^[1-9]\d*$/.test(sequence) || !present(row.SEG_VALUE) || !present(row.SEG_TYPE)) {
            throw new Error(`PFR route ${key} has an invalid segment`);
        }
        const segmentKey = `${key}:${Number(sequence)}`;
        if (segmentKeys.has(segmentKey)) throw new Error(`PFR duplicate segment sequence: ${segmentKey}`);
        segmentKeys.add(segmentKey);
        const group = groupedSegments.get(key) || [];
        group.push(row);
        groupedSegments.set(key, group);
    }

    const routes = routeRows.map((row, index) => compactObject({
        id: `preferred-route:${keys[index]}`,
        originId: present(row.ORIGIN_ID),
        originCity: present(row.ORIGIN_CITY),
        originState: present(row.ORIGIN_STATE_CODE),
        originCountry: present(row.ORIGIN_COUNTRY_CODE),
        destinationId: present(row.DSTN_ID),
        destinationCity: present(row.DSTN_CITY),
        destinationState: present(row.DSTN_STATE_CODE),
        destinationCountry: present(row.DSTN_COUNTRY_CODE),
        routeType: present(row.PFR_TYPE_CODE),
        routeNumber: numberValue(row.ROUTE_NO),
        area: present(row.SPECIAL_AREA_DESCRIP),
        // These are FAA descriptions, including combined aircraft/altitude codes.
        altitude: present(row.ALT_DESCRIP),
        aircraft: present(row.AIRCRAFT),
        hours: present(row.HOURS),
        direction: present(row.ROUTE_DIR_DESCRIP),
        designator: present(row.DESIGNATOR),
        narType: present(row.NAR_TYPE),
        inlandFix: present(row.INLAND_FAC_FIX),
        coastalFix: present(row.COASTAL_FIX),
        narDestination: present(row.DESTINATION),
        route: present(row.ROUTE_STRING),
        // Some published routes have no segment rows; retain their descriptions.
        segments: (groupedSegments.get(keys[index]) || [])
            .sort((left, right) => Number(left.SEGMENT_SEQ) - Number(right.SEGMENT_SEQ))
            .map(segment => compactObject({
                sequence: numberValue(segment.SEGMENT_SEQ),
                value: present(segment.SEG_VALUE),
                type: present(segment.SEG_TYPE),
                state: present(segment.STATE_CODE),
                country: present(segment.COUNTRY_CODE),
                icaoRegion: present(segment.ICAO_REGION_CODE),
                navaidType: present(segment.NAV_TYPE),
                next: present(segment.NEXT_SEG)
            }))
    }));

    return {
        type: 'ZLayerPreferredRoutes',
        metadata: { effectiveDate: effective, source: NASR_SOURCE },
        routes
    };
}

export function buildNasrProducts(input: NasrInput): NasrProducts {
    const airportRows = parseCsvRecords(input.airports, 'APT_BASE.csv');
    const runwayRows = parseCsvRecords(input.runways, 'APT_RWY.csv');
    const runwayEndRows = parseCsvRecords(input.runwayEnds, 'APT_RWY_END.csv');
    const frequencyRows = parseCsvRecords(input.frequencies, 'FRQ.csv');
    if (frequencyRows.length === 0) throw new Error('FRQ.csv contains no frequency records');
    for (const field of ['SERVICED_FACILITY', 'SERVICED_SITE_TYPE', 'SERVICED_STATE',
        'SERVICED_COUNTRY', 'FACILITY_TYPE', 'FREQ', 'FREQ_USE']) {
        if (!Object.hasOwn(frequencyRows[0], field)) throw new Error(`FRQ.csv is missing ${field}`);
    }
    const fixRows = parseCsvRecords(input.fixes, 'FIX_BASE.csv');
    const navaidRows = parseCsvRecords(input.navaids, 'NAV_BASE.csv');
    const airwayRows = parseCsvRecords(input.airways, 'AWY_BASE.csv');
    const segmentRows = parseCsvRecords(input.airwaySegments, 'AWY_SEG_ALT.csv');
    const preferredRouteRows = parseCsvRecords(input.preferredRoutes, 'PFR_BASE.csv');
    const preferredSegmentRows = parseCsvRecords(input.preferredRouteSegments, 'PFR_SEG.csv');
    const effective = effectiveDate([
        airportRows,
        runwayRows,
        runwayEndRows,
        frequencyRows,
        fixRows,
        navaidRows,
        airwayRows,
        segmentRows,
        preferredRouteRows,
        preferredSegmentRows
    ]);
    const sourceDate = effective.replaceAll('-', '/');
    for (const row of frequencyRows) {
        if (present(row.EFF_DATE) !== sourceDate) {
            throw new Error('FRQ record has a missing or mismatched effective date');
        }
    }

    const runwayEnds = new Map<string, Record<string, unknown>[]>();
    for (const row of runwayEndRows) {
        const siteNumber = present(row.SITE_NO);
        const facilityType = present(row.SITE_TYPE_CODE);
        const runwayId = present(row.RWY_ID);
        const id = present(row.RWY_END_ID);
        if (!siteNumber || !facilityType || !runwayId || !id) continue;
        const key = `${siteNumber}:${facilityType}:${runwayId}`;
        const ends = runwayEnds.get(key) || [];
        const heading = numberValue(row.TRUE_ALIGNMENT);
        const rightTraffic = booleanFlag(row.RIGHT_HAND_TRAFFIC_PAT_FLAG);
        ends.push(compactObject({
            id,
            trueHeadingDeg: heading !== undefined && heading >= 0 && heading <= 360
                ? heading : undefined,
            trafficPattern: rightTraffic === undefined ? undefined : rightTraffic ? 'right' : 'left'
        }));
        runwayEnds.set(key, ends);
    }

    const runways = new Map<string, Record<string, unknown>[]>();
    for (const row of runwayRows) {
        const siteNumber = present(row.SITE_NO);
        const facilityType = present(row.SITE_TYPE_CODE);
        if (!siteNumber || !facilityType) continue;
        const facilityKey = `${siteNumber}:${facilityType}`;
        const values = runways.get(facilityKey) || [];
        values.push(compactObject({
            id: present(row.RWY_ID),
            lengthFt: numberValue(row.RWY_LEN),
            widthFt: numberValue(row.RWY_WIDTH),
            surface: present(row.SURFACE_TYPE_CODE),
            condition: present(row.COND),
            lighting: present(row.RWY_LGT_CODE),
            ends: runwayEnds.get(`${facilityKey}:${present(row.RWY_ID)}`) || []
        }));
        runways.set(facilityKey, values);
    }

    const frequencies = airportFrequencyIndex(airportRows, frequencyRows);
    const airports = airportRows.flatMap(row => {
        const siteNumber = present(row.SITE_NO);
        const facilityType = present(row.SITE_TYPE_CODE);
        if (!siteNumber || !facilityType) return [];
        const airportRunways = runways.get(`${siteNumber}:${facilityType}`) || [];
        const longestRunwayFt = Math.max(
            0,
            ...airportRunways.map(runway => Number(runway.lengthFt) || 0)
        ) || undefined;
        const towerType = present(row.TWR_TYPE_CODE);
        const feature = pointFeature(`airport:${siteNumber}:${facilityType}`, row, {
            kind: 'landing-facility',
            siteNumber,
            facilityType,
            faaId: present(row.ARPT_ID),
            icaoId: present(row.ICAO_ID),
            name: present(row.ARPT_NAME),
            city: present(row.CITY),
            state: present(row.STATE_CODE),
            country: present(row.COUNTRY_CODE),
            ownership: present(row.OWNERSHIP_TYPE_CODE),
            use: present(row.FACILITY_USE_CODE),
            status: present(row.ARPT_STATUS),
            elevationFt: numberValue(row.ELEV),
            trafficPatternAltitudeFt: numberValue(row.TPA),
            chart: present(row.CHART_NAME),
            notamId: present(row.NOTAM_ID),
            towerType,
            towered: towerType ? towerType !== 'NON-ATCT' : undefined,
            fuelTypes: present(row.FUEL_TYPES),
            longestRunwayFt,
            frequencies: frequencies.get(`${siteNumber}:${facilityType}`) || [],
            runways: airportRunways
        });
        return feature ? [feature] : [];
    });

    const fixes = fixRows.flatMap(row => {
        const ident = present(row.FIX_ID);
        if (!ident) return [];
        const useCode = present(row.FIX_USE_CODE);
        const isVfr = useCode === 'VFR';
        const feature = pointFeature(
            [
                'fix',
                present(row.COUNTRY_CODE) || 'unknown',
                present(row.ICAO_REGION_CODE) || 'unknown',
                present(row.STATE_CODE) || 'unknown',
                ident
            ].join(':'),
            row,
            {
                kind: isVfr ? 'vfr-waypoint' : 'fix',
                ident,
                previousIdent: present(row.FIX_ID_OLD),
                useCode,
                chartingRemark: present(row.CHARTING_REMARK),
                charts: present(row.CHARTS)?.split(',').map(value => value.trim()).filter(Boolean),
                state: present(row.STATE_CODE),
                country: present(row.COUNTRY_CODE),
                icaoRegion: present(row.ICAO_REGION_CODE),
                highArtcc: present(row.ARTCC_ID_HIGH),
                lowArtcc: present(row.ARTCC_ID_LOW),
                minimumReceptionAltitudeFt: numberValue(row.MIN_RECEP_ALT),
                compulsory: present(row.COMPULSORY)
            }
        );
        return feature ? [feature] : [];
    });

    const navaids = navaidRows.flatMap(row => {
        const ident = present(row.NAV_ID);
        const type = present(row.NAV_TYPE);
        if (!ident || !type) return [];
        const feature = pointFeature(
            [
                'navaid',
                present(row.COUNTRY_CODE) || 'unknown',
                present(row.STATE_CODE) || 'unknown',
                present(row.CITY) || 'unknown',
                ident,
                type
            ].join(':'),
            row,
            {
                kind: 'navaid',
                ident,
                type,
                name: present(row.NAME),
                status: present(row.NAV_STATUS),
                city: present(row.CITY),
                state: present(row.STATE_CODE),
                country: present(row.COUNTRY_CODE),
                highArtcc: present(row.HIGH_ALT_ARTCC_ID),
                lowArtcc: present(row.LOW_ALT_ARTCC_ID),
                elevationFt: numberValue(row.ELEV),
                frequency: present(row.FREQ),
                stationDeclinationDeg: stationDeclination(row),
                channel: present(row.CHAN),
                publicUse: booleanFlag(row.PUBLIC_USE_FLAG),
                notamId: present(row.NOTAM_ID)
            }
        );
        return feature ? [feature] : [];
    });

    return {
        effectiveDate: effective,
        airports: collection(effective, airports, 'airports'),
        fixes: collection(effective, fixes, 'fixes'),
        vfrWaypoints: collection(
            effective,
            fixes.filter(feature => feature.properties.kind === 'vfr-waypoint'),
            'VFR waypoints'
        ),
        navaids: collection(effective, navaids, 'NAVAIDs'),
        airways: normalizeAirways(airwayRows, segmentRows, effective),
        preferredRoutes: normalizePreferredRoutes(preferredRouteRows, preferredSegmentRows, effective)
    };
}
