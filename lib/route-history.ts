import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createZstdDecompress } from 'node:zlib';
import { acquireChartBuildLock } from './chart-build-lock.ts';
import { sha256File } from './fs-utils.ts';
import { downloadFile } from './http-download.ts';

export const ROUTE_HISTORY_URL = 'https://aeronautiql.s3.amazonaws.com/databases/routes.sqlite.zst';

type RouteFrequency = {
    route: string;
    count: number;
    engineCounts: Record<string, number>;
    firstSeen: string;
    lastSeen: string;
};
type RoutePair = { origin: string; destination: string; totalCount: number; routes: RouteFrequency[] };

/** Source use counts are historical filed-route aggregates, not verified ATC clearances. */
export function readRouteHistory(file: string) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        // Reject malformed filed records instead of silently publishing partial counts.
        const invalid = db.prepare(`SELECT COUNT(*) AS count FROM sfdps_routes_by_type
            WHERE route_type = 'f' AND (
                typeof(use_count) != 'integer' OR use_count < 0
                OR (use_count > 0 AND (
                    origin IS NULL OR trim(origin) = ''
                    OR destination IS NULL OR trim(destination) = ''
                    OR route_string IS NULL OR trim(route_string) = ''
                    OR date(first_seen) IS NULL OR date(last_seen) IS NULL
                    OR julianday(first_seen) > julianday(last_seen)
                ))
            )`).get();
        if (invalid.count) throw new Error(`Route history contains ${invalid.count} invalid filed records`);

        const pairs: RoutePair[] = [];
        let pair: RoutePair;
        let route: RouteFrequency;
        let firstSeen: string;
        let lastSeen: string;
        let routeCount = 0;
        // Dates are UTC calendar days. Keep every route; no top-N or rolling-window filter.
        const rows = db.prepare(`SELECT origin, destination, route_string,
                COALESCE(NULLIF(engine_class, ''), 'Unknown') AS engine,
                SUM(use_count) AS count, MIN(date(first_seen)) AS first_seen,
                MAX(date(last_seen)) AS last_seen
            FROM sfdps_routes_by_type WHERE route_type = 'f' AND use_count > 0
            GROUP BY origin, destination, route_string, engine
            ORDER BY origin, destination, route_string, engine`).iterate();
        for (const row of rows) {
            const origin = String(row.origin);
            const destination = String(row.destination);
            const routeString = String(row.route_string);
            const count = Number(row.count);
            const first = String(row.first_seen);
            const last = String(row.last_seen);
            if (!Number.isSafeInteger(count) || count <= 0) throw new Error('Invalid route history count');
            if (!pair || pair.origin !== origin || pair.destination !== destination) {
                pair = { origin, destination, totalCount: 0, routes: [] };
                pairs.push(pair);
                route = undefined;
            }
            if (!route || route.route !== routeString) {
                route = { route: routeString, count: 0, engineCounts: {},
                    firstSeen: first, lastSeen: last };
                pair.routes.push(route);
                routeCount++;
            }
            route.count += count;
            pair.totalCount += count;
            if (!Number.isSafeInteger(pair.totalCount)) throw new Error('Route history total exceeds safe integer range');
            route.engineCounts = { ...route.engineCounts, [String(row.engine)]: count };
            if (first < route.firstSeen) route.firstSeen = first;
            if (last > route.lastSeen) route.lastSeen = last;
            if (!firstSeen || route.firstSeen < firstSeen) firstSeen = route.firstSeen;
            if (!lastSeen || route.lastSeen > lastSeen) lastSeen = route.lastSeen;
        }
        if (!pairs.length) throw new Error('Route history contains no filed routes with positive counts');
        for (const pair of pairs) pair.routes.sort((a, b) => b.count - a.count || a.route.localeCompare(b.route));
        return { pairs, routeCount, observationRange: { firstSeen, lastSeen } };
    } finally {
        db.close();
    }
}

type BuildOptions = {
    outputRoot: string;
    effectiveDate: string;
    destination: string;
    sourceFile?: string;
    offline?: boolean;
    fetch?: typeof globalThis.fetch;
};

export async function buildRouteHistory(options: BuildOptions) {
    if (options.offline && !options.sourceFile) {
        console.log('Historical filed routes skipped: local NASR build without --route-history-source');
        return undefined;
    }
    await fs.mkdir(options.outputRoot, { recursive: true });
    const work = await fs.mkdtemp(path.join(options.outputRoot, '.route-history-'));
    const extracted = path.join(work, 'routes.sqlite');
    let history: ReturnType<typeof readRouteHistory>;
    const readCompressedSource = async (file: string) => {
        await pipeline(createReadStream(file), createZstdDecompress(), createWriteStream(extracted));
        history = readRouteHistory(extracted);
    };
    const source: Record<string, string> = { name: 'Aeronautic AQ', url: 'https://aq.aeronautic.ai/',
        downloadUrl: ROUTE_HISTORY_URL };
    let cachedDownload: string;
    let releaseCache: (() => Promise<void>) | undefined;
    try {
        let database: string;
        if (options.sourceFile) {
            database = path.resolve(options.sourceFile);
            source.filename = path.basename(database);
            if (database.endsWith('.zst')) {
                await readCompressedSource(database);
                database = extracted;
            } else {
                history = readRouteHistory(database);
            }
        } else {
            // Hold the shared cache lock through download, validation and pruning.
            releaseCache = await acquireChartBuildLock(path.join(options.outputRoot, 'route-history'));
            const fetcher = options.fetch ?? globalThis.fetch;
            const response = await fetcher(ROUTE_HISTORY_URL, { method: 'HEAD',
                signal: AbortSignal.timeout(120_000) });
            if (!response.ok) throw new Error(`Route history source request failed (${response.status})`);
            const etag = response.headers.get('etag');
            const modified = response.headers.get('last-modified');
            if (!etag || !modified || !Number.isFinite(Date.parse(modified))) {
                throw new Error('Route history source is missing valid ETag/Last-Modified metadata');
            }
            source.etag = etag;
            source.lastModified = new Date(modified).toISOString();
            const key = createHash('sha256').update(etag).digest('hex');
            cachedDownload = path.join(options.outputRoot, 'route-history', `${key}.sqlite.zst`);
            await downloadFile(ROUTE_HISTORY_URL, cachedDownload, {
                userAgent: 'faa-regs-route-history-builder/1.0',
                // Each cache filename belongs to one upstream version. If-Match also
                // prevents a resumed transfer from mixing different source versions.
                fetch: (url, init) => {
                    const headers = new Headers(init?.headers);
                    headers.set('if-match', etag);
                    return fetcher(url, { ...init, headers });
                },
                validate: readCompressedSource
            });
            database = extracted;
        }

        source.sha256 = await sha256File(database);
        const document = {
            type: 'ZLayerRouteHistory', version: 1, effectiveDate: options.effectiveDate,
            source, countBasis: 'source-filed-route-use-count',
            observationRange: history.observationRange, pairs: history.pairs
        };
        const json = `${JSON.stringify(document)}\n`;
        await fs.mkdir(path.dirname(options.destination), { recursive: true });
        await pipeline(Readable.from([json]), createGzip({ level: 9 }), createWriteStream(options.destination));
        const bytes = (await fs.stat(options.destination)).size;
        // Only the compressed source is retained outside the public charts tree.
        if (cachedDownload) {
            const cache = path.dirname(cachedDownload);
            for (const name of await fs.readdir(cache)) {
                const match = name.match(/^([a-f0-9]{64}\.sqlite\.zst)(?:\.part)?$/);
                if (match && match[1] !== path.basename(cachedDownload)) {
                    await fs.rm(path.join(cache, name));
                }
            }
        }
        console.log(`Historical filed routes: ${history.pairs.length} pairs, ${history.routeCount} routes, `
            + `${(bytes / 1_000_000).toFixed(1)} MB gzip; observed ${history.observationRange.firstSeen}`
            + ` through ${history.observationRange.lastSeen}`);
        return { count: history.pairs.length, routeCount: history.routeCount, bytes,
            uncompressedBytes: Buffer.byteLength(json), source,
            observationRange: history.observationRange };
    } finally {
        await Promise.all([fs.rm(work, { recursive: true, force: true }), releaseCache?.()]);
    }
}
