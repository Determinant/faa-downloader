import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { TERRAIN_NODATA, terrainSpacing, terrainGridBounds } from './terrain-grid.ts';

export type TerrainBounds = [west: number, south: number, east: number, north: number];
export type TerrainBlock = { zoom: number; x: number; y: number };
export type TerrainBatch = TerrainBlock & { span: number; blocks: TerrainBlock[] };
export const TERRAIN_BATCH_SPAN = 8;
const exec = promisify(execFile);

export async function terrainCommand(command: string, args: string[]): Promise<string> {
    try {
        const { stdout } = await exec(command, args, { maxBuffer: 16 * 1024 * 1024,
            env: { ...process.env, PROJ_NETWORK: 'OFF', GDAL_PAM_ENABLED: 'NO', GDAL_CACHEMAX: '128' } });
        return stdout;
    } catch (error) {
        throw new Error(`${command} failed: ${String(error.stderr || error.message).trim()}`, { cause: error });
    }
}

export async function terrainGdalVersion(): Promise<string> {
    const versions = [];
    for (const command of ['gdalinfo', 'gdalbuildvrt', 'gdalwarp']) {
        versions.push((await terrainCommand(command, ['--version'])).trim());
    }
    return versions.join('; ');
}

export function intersects(a: TerrainBounds, b: TerrainBounds): boolean {
    return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

export function terrainBatchBounds(batch: TerrainBatch, paddingPixels = 0): TerrainBounds {
    return terrainGridBounds(batch.zoom, batch.x, batch.y, batch.span, paddingPixels);
}

export function terrainBatches(blocks: TerrainBlock[]): TerrainBatch[] {
    const batches = new Map<string, TerrainBatch>();
    for (const block of blocks) {
        const span = Math.min(TERRAIN_BATCH_SPAN, 2 ** block.zoom);
        const x = Math.floor(block.x / span) * span, y = Math.floor(block.y / span) * span;
        const key = `${block.zoom}/${x}/${y}`;
        if (!batches.has(key)) batches.set(key, { zoom: block.zoom, x, y, span, blocks: [] });
        batches.get(key)!.blocks.push(block);
    }
    return [...batches.values()];
}

/** The standard 1-arc-second product is a north-up NAD83 grid of elevations in metres. */
export async function inspectTerrainRaster(file: string): Promise<TerrainBounds> {
    const info = JSON.parse(await terrainCommand('gdalinfo', ['-json', '-noct', '-norat', file]));
    const band = info.bands?.[0], gt = info.geoTransform;
    if (info.driverShortName !== 'GTiff' || info.bands?.length !== 1 ||
        !['Float32', 'Float64'].includes(band?.type) || info.stac?.['proj:epsg'] !== 4269 ||
        !Array.isArray(info.size) || info.size.length !== 2 || !info.size.every(n => Number.isInteger(n) && n > 0) ||
        !Array.isArray(gt) || gt.length !== 6 || !gt.every(Number.isFinite) ||
        gt[1] <= 0 || gt[5] >= 0 || gt[2] !== 0 || gt[4] !== 0 ||
        band.noDataValue === undefined || (band.scale !== undefined && band.scale !== 1) ||
        (band.offset !== undefined && band.offset !== 0) || (band.unit && !/^m(eters?|etres?)?$/i.test(band.unit))) {
        throw new Error(`Expected a single-band, north-up NAD83 USGS elevation GeoTIFF in metres: ${file}`);
    }
    const bounds: TerrainBounds = [gt[0], gt[3] + gt[5] * info.size[1], gt[0] + gt[1] * info.size[0], gt[3]];
    if (bounds[0] < -181 || bounds[2] > 181 || bounds[1] < -90 || bounds[3] > 90) {
        throw new Error(`Invalid USGS elevation bounds: ${file}`);
    }
    return bounds;
}

/** Render up to 8×8 native tiles per GDAL invocation, then extract the requested 2×2 archives. */
export async function renderTerrainBatch(batch: TerrainBatch, files: string[], work: string): Promise<Buffer[]> {
    const width = batch.span * 256;
    let data: Buffer, bigEndian = false;
    let rasterWidth = width;
    if (!files.length) {
        data = Buffer.alloc(width * width * 4);
        for (let i = 0; i < data.length; i += 4) data.writeFloatLE(NaN, i);
    } else {
        if (files.some(file => /[\r\n]/.test(file))) throw new Error('Terrain paths must not contain newlines');
        const list = path.join(work, 'inputs.txt'), vrt = path.join(work, 'mosaic.vrt'), raw = path.join(work, 'elevation.bin');
        await fs.writeFile(list, `${files.join('\n')}\n`);
        // Never downsample fine sources in the mosaic before the maximum reduction below.
        await terrainCommand('gdalbuildvrt', ['-q', '-strict', '-overwrite', '-resolution', 'highest',
            '-vrtnodata', 'nan', '-input_file_list', list, vrt]);
        const step = terrainSpacing(batch.zoom);
        // Edge archives are padded with NoData, never wrapped across the date line or poles.
        rasterWidth = Math.min(width, Math.ceil(360 / step) - batch.x * 256);
        const rasterHeight = Math.min(width, Math.ceil(180 / step) - batch.y * 256);
        const west = -180 + batch.x * 256 * step, north = 90 - batch.y * 256 * step;
        await terrainCommand('gdalwarp', ['-q', '-overwrite', '-of', 'ENVI', '-co', 'SUFFIX=ADD',
            '-t_srs', 'EPSG:4326', '-novshift', '-r', 'max', '-ovr', 'NONE', '-wm', '64', '-ot', 'Float32', '-dstnodata', 'nan',
            '-te', String(west), String(north - rasterHeight * step),
            String(west + rasterWidth * step), String(north),
            '-ts', String(rasterWidth), String(rasterHeight), vrt, raw]);
        const header = await fs.readFile(`${raw}.hdr`, 'utf8');
        const order = header.match(/byte order\s*=\s*([01])/i)?.[1];
        if (order === undefined || !/data type\s*=\s*4\b/i.test(header)) throw new Error('Invalid GDAL float32 output');
        bigEndian = order === '1';
        data = await fs.readFile(raw);
        if (data.length !== rasterWidth * rasterHeight * 4) throw new Error('Incomplete GDAL terrain output');
    }
    return batch.blocks.flatMap(block => Array.from({ length: 4 }, (_, i) => {
        const grid = Buffer.alloc(256 * 256 * 2);
        const left = (block.x - batch.x + i % 2) * 256, top = (block.y - batch.y + Math.floor(i / 2)) * 256;
        for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
            const offset = ((top + y) * rasterWidth + left + x) * 4;
            const metres = left + x >= rasterWidth || offset >= data.length ? NaN :
                bigEndian ? data.readFloatBE(offset) : data.readFloatLE(offset);
            grid.writeInt16LE(!Number.isFinite(metres) || metres < -12000 || metres > 10000 ? TERRAIN_NODATA : Math.ceil(metres),
                (y * 256 + x) * 2);
        }
        return grid;
    }));
}
