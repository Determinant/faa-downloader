import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export type ChartMetadata = {
    bounds: [west: number, south: number, east: number, north: number];
    minZoom: number;
    maxZoom: number;
};

const execFileAsync = promisify(execFile);

export async function readChartMetadata(mbtilesPath: string): Promise<ChartMetadata> {
    try {
        const { stdout } = await execFileAsync('gdalinfo', [
            '-json', '-noct', '-norat', mbtilesPath
        ], { maxBuffer: 16 * 1024 * 1024 });
        return parseChartMetadata(JSON.parse(stdout));
    } catch (error) {
        throw new Error(`Unable to read chart metadata: ${mbtilesPath}`, { cause: error });
    }
}

export function parseChartMetadata(info: unknown): ChartMetadata {
    const metadata = isObject(info) && info.driverShortName === 'MBTiles'
        && isObject(info.metadata) ? info.metadata[''] : undefined;
    if (!isObject(metadata)) throw new Error('Missing MBTiles metadata');
    const minZoom = parseZoom(metadata.minzoom);
    const maxZoom = parseZoom(metadata.maxzoom);
    if (minZoom > maxZoom) throw new Error('Reversed MBTiles zoom limits');

    const values = typeof metadata.bounds === 'string' ? metadata.bounds.split(',') : [];
    if (values.length !== 4 || values.some(value => !value.trim())) {
        throw new Error('Missing MBTiles bounds');
    }
    const [west, south, east, north] = values.map(Number);
    if (![west, south, east, north].every(Number.isFinite) ||
        west >= east || south >= north || south < -90 || north > 90) {
        throw new Error('Invalid MBTiles bounds');
    }
    // Pixel-aligned extents can extend just beyond a split antimeridian panel.
    const bounds: ChartMetadata['bounds'] = [
        Math.max(-180, west), south, Math.min(180, east), north
    ];
    if (bounds[0] >= bounds[2]) throw new Error('MBTiles bounds lie outside the world');
    return { bounds, minZoom, maxZoom };
}

function parseZoom(value: unknown): number {
    if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) > 24) {
        throw new Error('Invalid MBTiles zoom level');
    }
    return Number(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
