import {
    CHARTMAKER_COMMIT,
    CHARTMAKER_CUTLINES,
    type LongitudeLatitude
} from './chartmaker-cutlines.ts';

const CHARTMAKER_PROVENANCE = `N129BZ/chartmaker@${CHARTMAKER_COMMIT}` as const;
const IFR_LOW_PROVENANCE =
    `${CHARTMAKER_PROVENANCE}+local-lambert-neatline@faa-raster-2026-09-03` as const;
const MEASURED_FLYWAY_PROVENANCE = 'local-measurement@faa-raster-2026-09-03';

export type { LongitudeLatitude } from './chartmaker-cutlines.ts';
export type ChartKind = 'vfr-sectional' | 'vfr-terminal' | 'vfr-flyway' | 'ifr-low';

export type ChartPresentation = {
    title: string;
    kind: ChartKind;
};

export type ChartDefinition = ChartPresentation & {
    coordinates: readonly LongitudeLatitude[];
    provenance: typeof CHARTMAKER_PROVENANCE
        | typeof IFR_LOW_PROVENANCE
        | typeof MEASURED_FLYWAY_PROVENANCE;
};

function defineChart(
    title: string,
    kind: ChartKind,
    coordinates: readonly LongitudeLatitude[],
    provenance: ChartDefinition['provenance']
): ChartDefinition {
    const uniqueCoordinates = new Set<string>();
    let twiceArea = 0;
    for (const [index, [longitude, latitude]] of coordinates.entries()) {
        if (!Number.isFinite(longitude) || !Number.isFinite(latitude)
            || longitude < -180 || longitude >= 180 || latitude < -90 || latitude > 90) {
            throw new Error(`Invalid cutline coordinate for ${title}: ${longitude}, ${latitude}`);
        }
        const key = `${longitude},${latitude}`;
        const previous = coordinates[index - 1];
        if (previous && key === `${previous[0]},${previous[1]}`) {
            throw new Error(`Repeated cutline coordinate for ${title}: ${key}`);
        }
        uniqueCoordinates.add(key);
        const next = coordinates[(index + 1) % coordinates.length];
        if (next) twiceArea += longitude * next[1] - next[0] * latitude;
    }
    const first = coordinates[0];
    const last = coordinates.at(-1);
    const explicitlyClosed = first && last && first[0] === last[0] && first[1] === last[1];
    if (uniqueCoordinates.size < 3 || Math.abs(twiceArea) < 1e-10 || explicitlyClosed) {
        throw new Error(`Degenerate cutline for ${title}`);
    }

    return {
        title,
        kind,
        coordinates,
        provenance
    };
}

function displayName(slug: string): string {
    if (slug === 'mcgrath') return 'McGrath';
    return slug.replaceAll('_', ' ').replace(
        /(^|[ -])([a-z])/g,
        (_, prefix: string, letter: string) => prefix + letter.toUpperCase()
    );
}

const SPECIAL_SECTIONAL_TITLES: Readonly<Record<string, string>> = {
    'western_aleutian_islands-east-eastern_hemisphere':
        'Western Aleutian Islands East (eastern hemisphere)',
    'western_aleutian_islands-east-western_hemisphere':
        'Western Aleutian Islands East (western hemisphere)',
    'western_aleutian_islands-west': 'Western Aleutian Islands West'
};

function presentationForFilename(filename: string): ChartPresentation {
    const ifr = filename.match(/^ifr-enroute-low-(l\d{2}[ns]?)\.tif$/);
    if (ifr) return { title: `IFR Low · ${ifr[1].toUpperCase()}`, kind: 'ifr-low' };

    const terminal = filename.match(/^vfr-terminal-(.+)\.tif$/);
    if (terminal) {
        return { title: `Terminal · ${displayName(terminal[1])}`, kind: 'vfr-terminal' };
    }

    const sectional = filename.match(/^vfr-sectional-(.+)\.tif$/);
    if (!sectional) throw new Error(`Unsupported chart definition filename: ${filename}`);
    return {
        title: `Sectional · ${
            SPECIAL_SECTIONAL_TITLES[sectional[1]] ?? displayName(sectional[1])
        }`,
        kind: 'vfr-sectional'
    };
}

const chartmakerDefinitions: Record<string, ChartDefinition> = Object.fromEntries(
    Object.entries(CHARTMAKER_CUTLINES).map(([filename, coordinates]) => {
        const presentation = presentationForFilename(filename);
        return [
            filename,
            defineChart(
                presentation.title,
                presentation.kind,
                coordinates,
                presentation.kind === 'ifr-low'
                    ? IFR_LOW_PROVENANCE
                    : CHARTMAKER_PROVENANCE
            )
        ];
    })
);

// chartmaker intentionally skips Flyway rasters, so these four neatlines retain
// the measurements taken from the 2026-09-03 FAA source images.
function measuredFlyway(
    location: string,
    coordinates: readonly LongitudeLatitude[]
): ChartDefinition {
    return defineChart(
        `Flyway · ${location}`,
        'vfr-flyway',
        coordinates,
        MEASURED_FLYWAY_PROVENANCE
    );
}

export const CHART_DEFINITIONS: Readonly<Record<string, ChartDefinition>> = {
    ...chartmakerDefinitions,
    'vfr-terminal-las_vegas-flyway.tif': measuredFlyway('Las Vegas', [
        [-115.6206143, 36.7335859],
        [-113.8640911, 36.7282806],
        [-113.8810639, 35.6960094],
        [-115.6131342, 35.7012372]
    ]),
    'vfr-terminal-los_angeles-flyway.tif': measuredFlyway('Los Angeles', [
        [-119.1506369, 34.5167127],
        [-116.7919421, 34.5160958],
        [-116.8094547, 33.4104841],
        [-119.1339565, 33.4110912]
    ]),
    'vfr-terminal-san_diego-flyway.tif': measuredFlyway('San Diego', [
        [-117.9808246, 33.6110718],
        [-116.2873074, 33.6105635],
        [-116.2999752, 32.5001958],
        [-117.9690959, 32.5006960]
    ]),
    'vfr-terminal-san_francisco-flyway.tif': measuredFlyway('San Francisco', [
        [-123.1630347, 38.1881322],
        [-121.3710227, 38.1883972],
        [-121.3852576, 37.0079315],
        [-123.1482484, 37.0076709]
    ])
};
