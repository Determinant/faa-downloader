import path from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { buildObstacles, DAILY_DOF_URL } from '../build-obstacles.ts';
import { gdalCommand } from './gdal.ts';
import { buildFingerprint, readCachedJson, writeCachedJson } from './build-cache.ts';
import { mapWithConcurrency, parseConcurrency } from './concurrency.ts';
import { cachedGlideSource, glideFetchText } from './glide-download.ts';
import type { Bounds, ResolvedAsset, VectorRole } from './glide-model.ts';

const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;
const OVERTURE_ATTRIBUTION = '© OpenStreetMap contributors (ODbL 1.0), Overture Maps Foundation and upstream contributors; https://docs.overturemaps.org/attribution/';
type ParquetPart = { bounds: Bounds; url: string };

export function glideBoundsOverlap(a: Bounds, b: Bounds): boolean {
    return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/** One spatial database per build; range-read remote Parquet, export indexed regional subsets. */
export class GlideVectorDownloader {
    private readonly catalogs = new Map<string, Promise<ParquetPart[]>>();
    private snapshot: Promise<{ release: string; dof: ResolvedAsset }> | undefined;
    private readonly available: DuckDBConnection[];
    private readonly waiting: ((connection: DuckDBConnection) => void)[] = [];
    private constructor(private readonly instance: DuckDBInstance, private readonly connections: DuckDBConnection[],
        private readonly cache: string, private readonly output: string) {
        this.available = [...connections];
    }

    /** Finish extension loading before starting concurrent GDAL child processes. */
    static async create(cache: string, output: string, concurrency = 1): Promise<GlideVectorDownloader> {
        parseConcurrency(concurrency, 'hazard concurrency');
        const instance = await DuckDBInstance.create(':memory:', { threads: String(2 * concurrency), memory_limit: `${512 * concurrency}MB`,
            extension_directory: path.join(cache, 'duckdb-extensions'), temp_directory: path.join(cache, 'duckdb-work') });
        const connections: DuckDBConnection[] = [];
        try {
            const connection = await instance.connect();
            connections.push(connection);
            // Official signed extensions are build tools, not delivered app data.
            await connection.run("INSTALL httpfs FROM 'https://extensions.duckdb.org'; LOAD httpfs; " +
                "INSTALL spatial FROM 'https://extensions.duckdb.org'; LOAD spatial; SET s3_region='us-west-2';");
            for (let i = 1; i < concurrency; i++) {
                const additional = await instance.connect();
                connections.push(additional);
                await additional.run("SET s3_region='us-west-2'");
            }
            return new GlideVectorDownloader(instance, connections, cache, output);
        } catch (error) { for (const connection of connections) connection.closeSync(); instance.closeSync(); throw error; }
    }

    close(): void { for (const connection of this.connections) connection.closeSync(); this.instance.closeSync(); }

    /** Keep catalog/FAA acquisition lazy even though the native runtime opens before regional work. */
    private inputs(): Promise<{ release: string; dof: ResolvedAsset }> {
        return this.snapshot ??= this.acquireInputs();
    }

    private async acquireInputs(): Promise<{ release: string; dof: ResolvedAsset }> {
        const catalog = JSON.parse(await glideFetchText('https://stac.overturemaps.org/catalog.json'));
        if (!/^\d{4}-\d{2}-\d{2}\.\d+$/.test(catalog.latest) || !catalog.links?.some(link =>
            link.rel === 'child' && link.latest === true && link.href === `https://stac.overturemaps.org/${catalog.latest}/catalog.json`)) {
            throw new Error('Overture catalog has no unambiguous current release');
        }
        // Share the normal obstacle ZIP cache and prepared snapshot. Only the
        // derived spatial index belongs to glide; consume under the obstacle
        // lock so a concurrent refresh cannot delete the file during indexing.
        let dof: ResolvedAsset | undefined;
        await buildObstacles({ output: this.output, onSnapshot: async (manifest, snapshot) => {
            dof = await cachedGlideSource(this.cache, { builder: 1, dof: manifest.dataset.sha256 }, {
                name: 'FAA Daily DOF (indexed preparation copy)', date: manifest.source.lastModified.slice(0, 10),
                attribution: 'FAA Daily Digital Obstacle File; public domain', url: DAILY_DOF_URL, revision: manifest.dataset.sha256
            }, 'gpkg', file => gdalCommand('ogr2ogr', ['-f', 'GPKG', '-nln', 'obstacles', '-lco', 'SPATIAL_INDEX=YES',
                file, `/vsigzip/${snapshot}`]).then(() => {}));
        } });
        if (!dof) throw new Error('FAA obstacle builder did not provide a prepared snapshot');
        return { release: catalog.latest, dof };
    }

    private parts(theme: string, type: string): Promise<ParquetPart[]> {
        const key = `${theme}/${type}`;
        if (!this.catalogs.has(key)) this.catalogs.set(key, (async () => {
            const { release } = await this.inputs();
            const url = `https://stac.overturemaps.org/${release}/${key}/collection.json`;
            const fingerprint = buildFingerprint({ version: 1, url }), file = path.join(this.cache, 'catalogs', `${fingerprint}.json`);
            const saved = await readCachedJson<ParquetPart[]>(file, `${file}.build.json`, fingerprint);
            if (saved) return saved;
            const collection = JSON.parse(await glideFetchText(url));
            const items = collection.links?.filter(link => link.rel === 'item');
            if (!items?.length || items.length > 20_000 || items.length !== collection['partition:file_count']) {
                throw new Error(`Incomplete Overture partition catalog: ${key}`);
            }
            console.log(`Glide: indexing ${items.length} ${key} map partitions (metadata only).`);
            const prefix = `https://stac.overturemaps.org/${release}/${key}/`;
            const parts = await mapWithConcurrency(items, 8, async (link: any): Promise<ParquetPart> => {
                if (typeof link.href !== 'string' || !link.href.startsWith(prefix)) throw new Error('Unexpected Overture partition link');
                const item = JSON.parse(await glideFetchText(link.href)), bounds = item.bbox, asset = item.assets?.aws;
                const dataPrefix = `https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/${release}/theme=${theme}/type=${type}/`;
                if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite) ||
                    bounds[0] > bounds[2] || bounds[1] > bounds[3] || typeof asset?.href !== 'string' ||
                    !asset.href.startsWith(dataPrefix) || !asset.href.endsWith('.parquet')) throw new Error('Invalid Overture partition footprint');
                return { bounds: bounds as Bounds, url: asset.href };
            });
            await writeCachedJson(file, `${file}.build.json`, fingerprint, parts);
            return parts;
        })());
        return this.catalogs.get(key)!;
    }

    private async source(theme: string, type: string, bounds: Bounds): Promise<string> {
        const parts = await this.parts(theme, type), matching = parts.filter(part => glideBoundsOverlap(part.bounds, bounds));
        // A disjoint file still provides a typed empty result through the bbox
        // predicate; no missing-dataset fallback or fabricated empty layer.
        const files = matching.length ? matching : parts.slice(0, 1);
        return `read_parquet([${files.map(part => sqlString(part.url)).join(',')}])`;
    }

    /** Small, already-classified map subsets. No imagery or CV. Query only the
     * terrain halo, not the much larger tall-obstacle inventory halo. */
    async downloadGround(bounds: Bounds, refresh = false): Promise<ResolvedAsset[]> {
        const { release } = await this.inputs();
        const connection = this.available.pop() ?? await new Promise<DuckDBConnection>(resolve => this.waiting.push(resolve));
        const [w, s, e, n] = bounds, envelope = `ST_MakeEnvelope(${w},${s},${e},${n})`;
        const overlaps = `bbox.xmin <= ${e} AND bbox.xmax >= ${w} AND bbox.ymin <= ${n} AND bbox.ymax >= ${s}`;
        const result: ResolvedAsset[] = [];
        try {
            for (const [type, filter, classification] of [
                // Display-generalized land-cover polygons are not exact forest
                // boundaries. Native WorldCover pixels supply this evidence;
                // retain explicitly mapped land uses and beaches below.
                ['land_use', "class IN ('grass','meadow','fairway','driving_range','pitch','industrial','landfill','quarry','basin','salt_pond')",
                    "CASE WHEN class IN ('grass','meadow','fairway','driving_range','pitch') THEN 1 ELSE 3 END"],
                // Wetlands live in `land`, not only `water`. In particular,
                // salt/restoration ponds can look bare in a classified raster.
                // Keep their explicitly mapped footprint as a hard exclusion.
                ['land', "class IN ('beach','wetland','glacier','scree','reef') AND ST_GeometryType(geometry) IN ('POLYGON','MULTIPOLYGON')",
                    "CASE WHEN class='beach' THEN 2 ELSE 3 END"],
            ]) {
                const source = await this.source('base', type, bounds);
                const query = `SELECT geometry,groundClass FROM (SELECT ST_Intersection(ST_MakeValid(geometry),${envelope}) AS geometry,${classification} AS groundClass FROM ${source} WHERE ${overlaps} AND (${filter})) WHERE NOT ST_IsEmpty(geometry) AND ST_Dimension(geometry)=2`;
                result.push({ ...await cachedGlideSource(this.cache, { kind: 'mapped-ground-v1', release, bounds, query }, {
                    name: `Overture mapped ground (${type})`, date: release.slice(0, 10), revision: release,
                    attribution: OVERTURE_ATTRIBUTION, url: `https://stac.overturemaps.org/${release}/catalog.json`
                }, 'gpkg', async file => {
                    await connection.run(`COPY (${query}) TO ${sqlString(file)} WITH (FORMAT GDAL, DRIVER 'GPKG', SRS 'EPSG:4326')`);
                }, refresh), groundSource: 'mapped' });
            }
            return result;
        } finally {
            const next = this.waiting.shift();
            if (next) next(connection); else this.available.push(connection);
        }
    }

    async download(bounds: Bounds, refresh = false): Promise<Record<VectorRole, ResolvedAsset[]>> {
        const { release, dof } = await this.inputs();
        // TEMP tables belong to a connection. Never let two regions share one.
        const connection = this.available.pop() ?? await new Promise<DuckDBConnection>(resolve => this.waiting.push(resolve));
        const result = {} as Record<VectorRole, ResolvedAsset[]>;
        const [w, s, e, n] = bounds;
        // Overlap, not containment: long wires and polygons crossing the query edge count.
        const overlaps = `bbox.xmin <= ${e} AND bbox.xmax >= ${w} AND bbox.ymin <= ${n} AND bbox.ymax >= ${s}`;
        let infrastructureLoaded = false;
        const infrastructure = async () => {
            if (!infrastructureLoaded) {
                await connection.run(`CREATE TEMP TABLE glide_infrastructure AS SELECT geometry, subtype, class,
                    COALESCE(height, 0) AS heightM, source_tags FROM ${await this.source('base', 'infrastructure', bounds)} WHERE ${overlaps}`);
                infrastructureLoaded = true;
            }
        };
        const asset = async (name: string, query: string, prepare?: () => Promise<void>) => cachedGlideSource(this.cache,
            { builder: 1, release, bounds, name, query }, {
                name: `Overture ${name}`, date: release.slice(0, 10), revision: release,
                attribution: OVERTURE_ATTRIBUTION, url: `https://stac.overturemaps.org/${release}/catalog.json`
            }, 'gpkg', async file => {
                await prepare?.();
                await connection.run(`COPY (${query}) TO ${sqlString(file)} WITH (FORMAT GDAL, DRIVER 'GPKG', SRS 'EPSG:4326')`);
            }, refresh);
        try {
            result.buildings = [{ ...await asset('building footprints', `SELECT geometry FROM ${await this.source('buildings', 'building', bounds)} WHERE ${overlaps}`),
                buildingSource: 'footprint' }];
            result.roads = [{ ...await asset('road and rail segments', `SELECT geometry, class FROM ${await this.source('transportation', 'segment', bounds)} WHERE ${overlaps}`), roadSource: 'typed' }];
            result.water = [await asset('water', `SELECT geometry FROM ${await this.source('base', 'water', bounds)} WHERE ${overlaps}`)];
            result.powerlines = [await asset('power, communication and aerialway infrastructure',
                "SELECT geometry FROM glide_infrastructure WHERE subtype IN ('power','communication','aerialway') OR class = 'minor_line'", infrastructure)];
            const localDof = await cachedGlideSource(this.cache, { builder: 1, dof: dof.sha256, bounds }, {
                name: 'FAA Daily DOF (regional subset)', date: dof.date, attribution: dof.attribution,
                url: DAILY_DOF_URL, revision: dof.revision
            }, 'geojson', async file => {
                await gdalCommand('ogr2ogr', ['-f', 'GeoJSON', '-nln', 'obstacles', '-spat_srs', 'EPSG:4326',
                    '-spat', ...bounds.map(String), file, dof.file]);
            });
            // Interpretation metadata is attached after cache lookup. Existing
            // source bytes remain reusable; analysis fingerprints include it.
            result.obstacles = [{ ...localDof, obstacleSource: 'faa-dof' }, { ...await asset('towers and elevated structures',
                `SELECT geometry, CASE WHEN source_tags['man_made']='crane' THEN 'crane' ELSE class END AS structureType, heightM FROM glide_infrastructure WHERE subtype='tower'
                    OR class LIKE '%tower%' OR class LIKE '%mast%' OR class='pylon' OR heightM > 15
                    OR source_tags['man_made']='crane'`, infrastructure), obstacleSource: 'mapped' }];
            result.buildings.push({ ...await asset('barriers, ditches and other ground infrastructure',
                "SELECT geometry FROM glide_infrastructure WHERE subtype='barrier' OR class IN ('ditch','drain','dam','weir','bridge','retaining_wall')", infrastructure),
                buildingSource: 'ground-barrier' });
            return result;
        } finally {
            try { if (infrastructureLoaded) await connection.run('DROP TABLE glide_infrastructure'); }
            finally {
                const next = this.waiting.shift();
                if (next) next(connection);
                else this.available.push(connection);
            }
        }
    }
}
