import { DatabaseSync } from 'node:sqlite';
import type { ChartManifest } from './chart-tiler.ts';
import { overviewTile, overzoomTile } from './chart-package-images.ts';
import { tileRange, type Tile } from './chart-package-grid.ts';

export class PackageSource {
    readonly db: DatabaseSync;
    readonly native;
    readonly overview;
    readonly ranges;

    constructor(readonly chart: ChartManifest['charts'][number], file: string, readonly work: DatabaseSync) {
        this.db = new DatabaseSync(file, { readOnly: true });
        try {
            this.db.exec('PRAGMA cache_size = -1024');
            this.native = this.db.prepare('SELECT tile_data AS data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?');
            this.overview = work.prepare('SELECT data FROM overviews WHERE source=? AND z=? AND x=? AND y=?');
            this.ranges = Array.from({ length: 25 }, (_, zoom) => tileRange(chart.bounds, zoom));
        } catch (error) { this.db.close(); throw error; }
    }

    async prepare(): Promise<void> {
        const levels = this.db.prepare('SELECT MIN(zoom_level) AS min, MAX(zoom_level) AS max FROM tiles').get();
        if (levels?.min !== this.chart.minZoom || levels?.max !== this.chart.maxZoom) {
            throw new Error(`Sheet zoom range disagrees with its manifest: ${this.chart.id}`);
        }
        const insert = this.work.prepare('INSERT INTO overviews VALUES (?,?,?,?,?)');
        let children = this.db.prepare('SELECT tile_column AS x, tile_row AS tmsY FROM tiles WHERE zoom_level=?')
            .all(this.chart.minZoom).map(row => ({ x: Number(row.x), y: 2 ** this.chart.minZoom - 1 - Number(row.tmsY) }));
        for (let z = this.chart.minZoom - 1; z >= 0; z -= 1) {
            const parents = new Map(children.map(({ x, y }) => {
                const tile = { x: Math.floor(x / 2), y: Math.floor(y / 2) };
                return [`${tile.x}/${tile.y}`, tile] as const;
            }));
            for (const parent of parents.values()) {
                const parts = [];
                for (let dy = 0; dy < 2; dy += 1) for (let dx = 0; dx < 2; dx += 1) {
                    const data = this.read({ z: z + 1, x: parent.x * 2 + dx, y: parent.y * 2 + dy });
                    if (data) parts.push({ input: data, left: dx * 256, top: dy * 256 });
                }
                insert.run(this.chart.id, z, parent.x, parent.y, await overviewTile(parts));
            }
            children = [...parents.values()];
        }
    }

    private read(tile: Tile): Buffer | undefined {
        const row = tile.z < this.chart.minZoom
            ? this.overview.get(this.chart.id, tile.z, tile.x, tile.y)
            : this.native.get(tile.z, tile.x, 2 ** tile.z - 1 - tile.y);
        return row?.data ? Buffer.from(row.data as Uint8Array) : undefined;
    }

    async tile(tile: Tile): Promise<Buffer | undefined> {
        const [x0, y0, x1, y1] = this.ranges[tile.z];
        if (tile.x < x0 || tile.x > x1 || tile.y < y0 || tile.y > y1) return undefined;
        if (tile.z <= this.chart.maxZoom) return this.read(tile);
        const scale = 2 ** (tile.z - this.chart.maxZoom);
        const parent = this.read({ z: this.chart.maxZoom, x: Math.floor(tile.x / scale), y: Math.floor(tile.y / scale) });
        return parent ? overzoomTile(parent, tile.x, tile.y, scale) : undefined;
    }

    close(): void { this.db.close(); }
}
