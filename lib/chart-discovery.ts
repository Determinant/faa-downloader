import path from 'node:path';
import { JSDOM } from 'jsdom';

const CS_URL = 'https://aeronav.faa.gov/upload_313-d/supplements/';
const TPP_URL = 'https://aeronav.faa.gov/upload_313-d/terminal/';
const IFR_ENROUTE_URL = 'https://aeronav.faa.gov/enroute/';
const VFR_URL = 'https://aeronav.faa.gov/visual/';
const REQUEST_TIMEOUT_MS = 120_000;

const CS_REGIONS = ['AK', 'EC', 'NC', 'NE', 'NW', 'PAC', 'SC', 'SE', 'SW'] as const;
const TPP_REGIONS = [
    'AK',
    'EC1', 'EC2', 'EC3',
    'NC1', 'NC2', 'NC3',
    'NE1', 'NE2', 'NE3', 'NE4',
    'NW1',
    'SC1', 'SC2', 'SC3', 'SC4', 'SC5',
    'SE1', 'SE2', 'SE3', 'SE4',
    'SW1', 'SW2', 'SW3', 'SW4'
] as const;
// The FAA currently publishes the conterminous U.S. low-altitude series as L01-L36.
const IFR_ENROUTE_REGIONS = Array.from(
    { length: 36 },
    (_, index) => `L${String(index + 1).padStart(2, '0')}`
);
const VFR_SECTIONAL_REGIONS = [
    'Albuquerque',
    'Anchorage',
    'Atlanta',
    'Bethel',
    'Billings',
    'Brownsville',
    'Cape_Lisburne',
    'Charlotte',
    'Cheyenne',
    'Chicago',
    'Cincinnati',
    'Cold_Bay',
    'Dallas-Ft_Worth',
    'Dawson',
    'Denver',
    'Detroit',
    'Dutch_Harbor',
    'El_Paso',
    'Fairbanks',
    'Great_Falls',
    'Green_Bay',
    'Halifax',
    'Hawaiian_Islands',
    'Houston',
    'Jacksonville',
    'Juneau',
    'Kansas_City',
    'Ketchikan',
    'Klamath_Falls',
    'Kodiak',
    'Lake_Huron',
    'Las_Vegas',
    'Los_Angeles',
    'McGrath',
    'Memphis',
    'Miami',
    'Montreal',
    'New_Orleans',
    'New_York',
    'Nome',
    'Omaha',
    'Phoenix',
    'Point_Barrow',
    'Salt_Lake_City',
    'San_Antonio',
    'San_Francisco',
    'Seattle',
    'Seward',
    'St_Louis',
    'Twin_Cities',
    'Washington',
    'Western_Aleutian_Islands',
    'Wichita'
] as const;
// San Diego is a TAC covered by the Los Angeles Sectional; the FAA does not
// publish a separate San_Diego.zip in the sectional-files directory.
const VFR_TERMINAL_REGIONS = [
    'San_Francisco',
    'Los_Angeles',
    'San_Diego',
    'Las_Vegas'
] as const;

export type ChartExtraction = {
    sourceName: string;
    filename: string;
};

function ifrExtractions(region: string): ChartExtraction[] {
    if (region === 'L06') {
        return [
            {
                sourceName: 'ENR_L06N.tif',
                filename: 'ifr-enroute-low-l06n.tif'
            },
            {
                sourceName: 'ENR_L06S.tif',
                filename: 'ifr-enroute-low-l06s.tif'
            }
        ];
    }
    return [{
        sourceName: `ENR_${region}.tif`,
        filename: `ifr-enroute-low-${region.toLowerCase()}.tif`
    }];
}

function sectionalExtractions(region: string): ChartExtraction[] {
    if (region === 'Hawaiian_Islands') {
        return [
            {
                sourceName: 'Hawaiian_Islands_SEC.tif',
                filename: 'vfr-sectional-hawaiian_islands.tif'
            },
            {
                sourceName: 'Honolulu_Inset_SEC.tif',
                filename: 'vfr-sectional-honolulu_inset.tif'
            },
            {
                sourceName: 'Mariana_Islands_Inset_SEC.tif',
                filename: 'vfr-sectional-mariana_islands_inset.tif'
            },
            {
                sourceName: 'Samoan_Islands_Inset_SEC.tif',
                filename: 'vfr-sectional-samoan_islands_inset.tif'
            }
        ];
    }
    if (region === 'Western_Aleutian_Islands') {
        // The east panel crosses the antimeridian. Extract it twice so each
        // hemisphere can be cut and projected without spanning the whole world.
        return [
            {
                sourceName: 'Western_Aleutian_Islands_East_SEC.tif',
                filename: 'vfr-sectional-western_aleutian_islands-east-eastern_hemisphere.tif'
            },
            {
                sourceName: 'Western_Aleutian_Islands_East_SEC.tif',
                filename: 'vfr-sectional-western_aleutian_islands-east-western_hemisphere.tif'
            },
            {
                sourceName: 'Western_Aleutian_Islands_West_SEC.tif',
                filename: 'vfr-sectional-western_aleutian_islands-west.tif'
            }
        ];
    }
    return [{
        sourceName: `${region}_SEC.tif`,
        filename: `vfr-sectional-${region.toLowerCase()}.tif`
    }];
}

function terminalExtractions(region: string): ChartExtraction[] {
    const prefix = `vfr-terminal-${region.toLowerCase()}`;
    return [
        { sourceName: `${region}_TAC.tif`, filename: `${prefix}.tif` },
        { sourceName: `${region}_FLY.tif`, filename: `${prefix}-flyway.tif` }
    ];
}

export function configuredRasterFilenames(): string[] {
    return [
        ...IFR_ENROUTE_REGIONS.flatMap(region => ifrExtractions(region)),
        ...VFR_SECTIONAL_REGIONS.flatMap(region => sectionalExtractions(region)),
        ...VFR_TERMINAL_REGIONS.flatMap(region => terminalExtractions(region))
    ].map(extraction => extraction.filename).sort();
}

export type ChartCandidate = {
    url: string;
    date: string;
    extractions?: ChartExtraction[];
};

type RegionListing = {
    current?: ChartCandidate;
};

type RegionMap = Record<string, RegionListing>;

export type ChartGroup = {
    prefix: string;
    files: RegionMap;
};

type DiscoveryContext = {
    fetch: typeof globalThis.fetch;
    today: string;
};

type PublicationDirectory = {
    date: string;
    url: string;
};

function createRegionMap(regions: readonly string[]): RegionMap {
    return Object.fromEntries(regions.map(region => [region, {}])) as RegionMap;
}

function addCandidate(
    files: RegionMap,
    region: string,
    candidate: ChartCandidate,
    today: string
): void {
    const listing = files[region];
    if (!listing || candidate.date > today) return;
    if (!listing.current || candidate.date > listing.current.date) listing.current = candidate;
}

function parseDateKey(value: string): string | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
        ? null
        : value;
}

function parseCompactDate(value: string): string | null {
    const match = value.match(/^(\d{4})(\d{2})(\d{2})$/);
    return match ? parseDateKey(`${match[1]}-${match[2]}-${match[3]}`) : null;
}

function parseAmericanDate(value: string): string | null {
    const match = value.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    return match ? parseDateKey(`${match[3]}-${match[1]}-${match[2]}`) : null;
}

function anchors(dom: JSDOM): HTMLAnchorElement[] {
    return Array.from(dom.window.document.querySelectorAll('a'));
}

function anchorHref(anchor: HTMLAnchorElement): string {
    return String(anchor.getAttribute('href') || '').trim();
}

function anchorFilename(anchor: HTMLAnchorElement): string {
    const href = anchorHref(anchor);
    return String(anchor.textContent || '').trim() || path.basename(href);
}

function latestPublishedDirectory(
    dom: JSDOM,
    baseUrl: string,
    pattern: RegExp,
    parseDate: (value: string) => string | null,
    today: string
): PublicationDirectory | undefined {
    const directories = anchors(dom).flatMap(anchor => {
        const href = anchorHref(anchor);
        const rawDate = `${anchor.textContent || ''} ${href}`.match(pattern)?.[1];
        const date = rawDate ? parseDate(rawDate) : null;
        if (!rawDate || !date || date > today) return [];

        const url = new URL(href || rawDate, baseUrl);
        if (!url.pathname.endsWith('/')) url.pathname += '/';
        return [{ date, url: url.href }];
    });
    return directories.sort((left, right) => right.date.localeCompare(left.date))[0];
}

async function fetchDom(url: string, context: DiscoveryContext): Promise<JSDOM> {
    const response = await context.fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { 'user-agent': 'faa-regs-chart-builder/1.0' }
    });
    if (!response.ok) {
        throw new Error(`FAA request failed (${response.status} ${response.statusText}): ${url}`);
    }
    return new JSDOM(await response.text(), { url });
}

async function discoverChartSupplements(context: DiscoveryContext): Promise<RegionMap> {
    const files = createRegionMap(CS_REGIONS);
    for (const anchor of anchors(await fetchDom(CS_URL, context))) {
        const href = anchorHref(anchor);
        const filename = anchorFilename(anchor);
        const match = filename.match(/^CS_([A-Z]+)_(\d{8})\.pdf$/i);
        const date = match ? parseCompactDate(match[2]) : null;
        if (!match || !date) continue;

        addCandidate(files, match[1].toUpperCase(), {
            url: new URL(href || filename, CS_URL).href,
            date
        }, context.today);
    }
    return files;
}

async function discoverTerminalProcedures(context: DiscoveryContext): Promise<RegionMap> {
    const files = createRegionMap(TPP_REGIONS);
    const directory = latestPublishedDirectory(
        await fetchDom(TPP_URL, context),
        TPP_URL,
        /(\d{4}-\d{2}-\d{2})/,
        parseDateKey,
        context.today
    );
    if (!directory) return files;

    for (const anchor of anchors(await fetchDom(directory.url, context))) {
        const href = anchorHref(anchor);
        const filename = anchorFilename(anchor);
        const match = filename.match(/^([A-Z0-9]+)\.pdf$/i);
        if (!match) continue;
        addCandidate(files, match[1].toUpperCase(), {
            url: new URL(href || filename, directory.url).href,
            date: directory.date
        }, context.today);
    }
    return files;
}

async function discoverIfrEnroute(context: DiscoveryContext): Promise<RegionMap> {
    const files = createRegionMap(IFR_ENROUTE_REGIONS);
    const directory = latestPublishedDirectory(
        await fetchDom(IFR_ENROUTE_URL, context),
        IFR_ENROUTE_URL,
        /(\d{2}-\d{2}-\d{4})/,
        parseAmericanDate,
        context.today
    );
    if (!directory) return files;

    for (const anchor of anchors(await fetchDom(directory.url, context))) {
        const href = anchorHref(anchor);
        const filename = anchorFilename(anchor);
        const match = filename.match(/^ENR_([A-Z0-9]+)\.zip$/i);
        if (!match) continue;

        const region = match[1].toUpperCase();
        addCandidate(files, region, {
            url: new URL(href || filename, directory.url).href,
            date: directory.date,
            extractions: ifrExtractions(region)
        }, context.today);
    }
    return files;
}

async function discoverVfr(context: DiscoveryContext): Promise<{
    sectional: RegionMap;
    terminal: RegionMap;
}> {
    const sectional = createRegionMap(VFR_SECTIONAL_REGIONS);
    const terminal = createRegionMap(VFR_TERMINAL_REGIONS);
    const directory = latestPublishedDirectory(
        await fetchDom(VFR_URL, context),
        VFR_URL,
        /(\d{2}-\d{2}-\d{4})/,
        parseAmericanDate,
        context.today
    );
    if (!directory) return { sectional, terminal };

    const sectionalUrl = new URL('sectional-files/', directory.url).href;
    const terminalUrl = new URL('tac-files/', directory.url).href;
    const [sectionalDom, terminalDom] = await Promise.all([
        fetchDom(sectionalUrl, context),
        fetchDom(terminalUrl, context)
    ]);

    for (const anchor of anchors(sectionalDom)) {
        const href = anchorHref(anchor);
        const filename = anchorFilename(anchor);
        const match = filename.match(/^(.+)\.zip$/i);
        if (!match) continue;
        const region = match[1];
        addCandidate(sectional, region, {
            url: new URL(href || filename, sectionalUrl).href,
            date: directory.date,
            extractions: sectionalExtractions(region)
        }, context.today);
    }

    for (const anchor of anchors(terminalDom)) {
        const href = anchorHref(anchor);
        const filename = anchorFilename(anchor);
        const match = filename.match(/^(.+)_TAC\.zip$/i);
        if (!match) continue;
        const region = match[1];
        addCandidate(terminal, region, {
            url: new URL(href || filename, terminalUrl).href,
            date: directory.date,
            extractions: terminalExtractions(region)
        }, context.today);
    }
    return { sectional, terminal };
}

export async function discoverCharts(options: {
    fetch?: typeof globalThis.fetch;
    today?: string;
} = {}): Promise<ChartGroup[]> {
    const today = options.today ?? new Date().toISOString().slice(0, 10);
    if (!parseDateKey(today)) throw new Error('today must use YYYY-MM-DD');
    const context: DiscoveryContext = {
        fetch: options.fetch ?? globalThis.fetch,
        today
    };
    const [supplements, terminalProcedures, ifrEnroute, vfr] = await Promise.all([
        discoverChartSupplements(context),
        discoverTerminalProcedures(context),
        discoverIfrEnroute(context),
        discoverVfr(context)
    ]);
    const requiredRasterGroups = [
        { prefix: 'ifr-enroute-low', files: ifrEnroute },
        { prefix: 'vfr-sectional', files: vfr.sectional },
        { prefix: 'vfr-terminal', files: vfr.terminal }
    ];
    const missing = requiredRasterGroups.flatMap(group =>
        Object.entries(group.files).flatMap(([region, listing]) =>
            listing.current ? [] : [`${group.prefix}/${region}`]
        )
    );
    if (missing.length > 0) {
        throw new Error(
            `FAA listings are missing required current charts: ${missing.join(', ')}`
        );
    }
    return [
        { prefix: 'cs', files: supplements },
        { prefix: 'tpp', files: terminalProcedures },
        { prefix: 'ifr-enroute-low', files: ifrEnroute },
        { prefix: 'vfr-sectional', files: vfr.sectional },
        { prefix: 'vfr-terminal', files: vfr.terminal }
    ];
}
