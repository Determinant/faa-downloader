import { gdalCommand } from './gdal.ts';
import { cachedGlideSource, glideFetchText, glideXml, xmlElements } from './glide-download.ts';
import { inspectGlideRaster } from './glide-sources.ts';
import type { Bounds, ResolvedAsset } from './glide-model.ts';

const ROOT = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com/';
const PREFIX = 'v200/2021/map/ESA_WorldCover_10m_2021_v200_';
type Tile = { url: string; etag: string };

/** Range-read an existing categorical product, never imagery or a local classifier.
 * Keep native pixels and cache subsets. These older data corroborate purple only;
 * current NLCD, canopy, terrain and mapped hazards still have to pass. */
export class GlideFineCoverDownloader {
    private readonly tiles = new Map<string, Promise<Tile | undefined>>();
    constructor(private readonly downloadCommand: typeof gdalCommand = gdalCommand) {}

    private tile(id: string): Promise<Tile | undefined> {
        if (!this.tiles.has(id)) this.tiles.set(id, (async () => {
            const key = `${PREFIX}${id}_Map.tif`, listing = new URL(ROOT);
            listing.search = new URLSearchParams({ 'list-type': '2', prefix: key, 'max-keys': '10' }).toString();
            const root = glideXml(await glideFetchText(listing.href));
            const text = (node: typeof root, name: string) => xmlElements(node, name)[0]?.textContent?.trim();
            if (text(root, 'Prefix') !== key || text(root, 'IsTruncated') !== 'false') throw new Error('Incomplete WorldCover listing');
            const objects = xmlElements(root, 'Contents').filter(node => text(node, 'Key') === key);
            if (!objects.length) return; // Ocean-only tiles are not published.
            const etag = text(objects[0], 'ETag');
            if (objects.length !== 1 || !/^"[^"\r\n]+"$/.test(etag ?? '')) throw new Error('Invalid WorldCover object identity');
            return { url: ROOT + key, etag: etag! };
        })());
        return this.tiles.get(id)!;
    }

    async download(bounds: Bounds, cache: string, refresh = false): Promise<ResolvedAsset[]> {
        const assets: ResolvedAsset[] = [];
        for (let south = Math.floor(bounds[1] / 3) * 3; south < bounds[3]; south += 3) {
            for (let west = Math.floor(bounds[0] / 3) * 3; west < bounds[2]; west += 3) {
                const id = `${south < 0 ? 'S' : 'N'}${String(Math.abs(south)).padStart(2, '0')}` +
                    `${west < 0 ? 'W' : 'E'}${String(Math.abs(west)).padStart(3, '0')}`;
                const tile = await this.tile(id);
                if (!tile) continue;
                const window = [Math.max(bounds[0], west), Math.max(bounds[1], south),
                    Math.min(bounds[2], west + 3), Math.min(bounds[3], south + 3)];
                assets.push(await cachedGlideSource(cache, { kind: 'worldcover-native-v1', tile, window }, {
                    name: `ESA WorldCover 2021 v200 ${id} (native 10 m subset)`, date: '2021-12-31',
                    url: tile.url, revision: tile.etag,
                    attribution: 'ESA WorldCover 2021 / v200, CC BY 4.0; https://doi.org/10.5281/zenodo.7254221'
                }, 'tif', async file => {
                    await this.downloadCommand('gdal_translate', ['--config', 'GDAL_DISABLE_READDIR_ON_OPEN', 'EMPTY_DIR',
                        '--config', 'GDAL_HTTP_HEADERS', `If-Match: ${tile.etag}`,
                        '--config', 'GDAL_HTTP_CONNECTTIMEOUT', '30', '--config', 'GDAL_HTTP_TIMEOUT', '120',
                        '--config', 'GDAL_HTTP_MAX_RETRY', '3', '-q', '-of', 'GTiff', '-ovr', 'NONE',
                        '-projwin_srs', 'EPSG:4326', '-projwin', String(window[0]), String(window[3]), String(window[2]), String(window[1]),
                        '-co', 'COMPRESS=DEFLATE', '-co', 'TILED=YES', `/vsicurl/${tile.url}`, file]);
                    await inspectGlideRaster(file, 'fineLandcover');
                }, refresh));
            }
        }
        return assets;
    }
}
