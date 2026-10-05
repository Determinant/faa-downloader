import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { acquireChartBuildLock } from './chart-build-lock.ts';
import { copyFileAtomic, writeFileAtomic } from './fs-utils.ts';
import { matchesFile } from './build-cache.ts';
import { validateRegions, type OfflineRegionDefinition, type Bounds } from './offline-regions.ts';
import { packageRoot } from './chart-package-grid.ts';
import { artifact, DELIVERY_LIMITS as L, hash, intersects, jsonBytes, unionBounds,
    type Archive, type Artifact, type DeliveryManifest, type Page, type RegionReference, type StoredBlock } from './glide-delivery.ts';
import { encodeArchive, readArchiveDirectory } from './glide-package-archive.ts';
import { checkPackagePaths, pinGlideInput } from './glide-package-input.ts';
import { buildOverview, type Mask } from './glide-package-overview.ts';
import { packageSourceJobs } from './glide-package-workers.ts';
import { reassembleFrozenGlide } from './glide-frozen-analysis.ts';
import { validateDeliveryManifest, validateDependencyPage, validateIndex, validateRegionInventory } from './glide-package-validation.ts';

export type PackageGlideOptions = { input: string; output: string; regions?: OfflineRegionDefinition[];
    maxBytes?: number; overviewZoom?: number; forcePackaging?: boolean; concurrency?: number; reassemble?: boolean; log?: (message: string) => void };
export async function deliveryImplementation(names: string[]): Promise<string> {
    const digest = createHash('sha256');
    for (const name of names) digest.update(name).update(await fs.readFile(new URL(`./${name}.ts`, import.meta.url)));
    return digest.digest('hex');
}
/** Coverage of declared source rectangles, not completeness of their underlying source pixels. */
export function glideRegionCoverage(bounds: Bounds[], coverage: { bounds: Bounds }[]): 'available' | 'partial' | 'unavailable' {
    if (!bounds.some(b => coverage.some(({ bounds: c }) => b[0] < c[2] && b[2] > c[0] && b[1] < c[3] && b[3] > c[1]))) return 'unavailable';
    for (const b of bounds) {
        const rectangles = coverage.map(c => c.bounds).filter(c => intersects(b, c));
        const xs = [...new Set([b[0], b[2], ...rectangles.flatMap(c => [Math.max(b[0], c[0]), Math.min(b[2], c[2])])])].sort((a, b) => a - b);
        for (let i = 1; i < xs.length; i++) {
            const x = (xs[i - 1] + xs[i]) / 2;
            const intervals = rectangles.filter(c => c[0] <= x && c[2] >= x).map(c => [Math.max(b[1], c[1]), Math.min(b[3], c[3])]).sort((a, b) => a[0] - b[0]);
            let north = b[1];
            for (const [south, end] of intervals) { if (south > north) break; north = Math.max(north, end); }
            if (north < b[3]) return 'partial';
        }
    }
    return 'available';
}

/** This entry point has no analysis/source-acquisition dependency; its workers only encode frozen records. */
export async function packageGlide(options: PackageGlideOptions): Promise<DeliveryManifest> {
    const { input: inputFile, output, forcePackaging: force = false, log = console.log } = options;
    const maxBytes = options.maxBytes ?? L.releaseBytes - 1, zoom = options.overviewZoom ?? 10;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes >= L.releaseBytes) throw new Error('--max-bytes must be positive and below 5000000000');
    if (![10, 11].includes(zoom)) throw new Error('--overview-zoom must be 10 or 11');
    if (options.concurrency !== undefined && (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8)) throw new Error('Packaging concurrency must be 1..8');
    const regions: OfflineRegionDefinition[] = options.regions ?? JSON.parse(await fs.readFile(new URL('../data/terrain-regions.json', import.meta.url), 'utf8'));
    validateRegions(regions);
    if (regions.length > 10_000) throw new Error('Too many glide offline regions');
    await checkPackagePaths(inputFile, output);
    const root = path.resolve(output), cache = path.join(root, 'glide-package-cache'), directory = path.join(root, 'charts/glide');
    const release = await acquireChartBuildLock(cache);
    try {
        const input = options.reassemble ? await reassembleFrozenGlide(inputFile, cache, log) : await pinGlideInput(inputFile, cache, log);
        const { manifest: source } = input;
        const detailImplementation = await deliveryImplementation(['glide-delivery', 'glide-package-archive', 'glide-package-detail', 'chart-package-grid']);
        const overviewImplementation = await deliveryImplementation(['glide-delivery', 'glide-package-archive', 'glide-package-overview', 'chart-package-grid']);
        const packagingSha256 = hash(jsonBytes([detailImplementation, overviewImplementation,
            await deliveryImplementation(['glide-delivery', 'glide-package-archive', 'glide-package-input', 'glide-package-worker',
                'glide-package-workers', 'glide-package-validation', 'chart-package-grid', 'glide-packager'])]));
        log(`Glide repack: pinned ${input.manifestSha256}; original engine v${source.builderVersion}, record schema ${source.schemaVersion}. No source downloads or analysis.`);
        const detail: StoredBlock[] = [], masks: Mask[] = [], exact = createHash('sha256');
        let records = 0, prepared = 0;
        const results = await packageSourceJobs(source.shards.map(shard => ({ source: shard, directory: input.directory, schema: source.schemaVersion,
            cache, detailImplementation, overviewImplementation, force, zoom })), options.concurrency ?? 4, (completed, result) => {
            prepared += result.records;
            if (completed % 20 === 0 || completed === source.shards.length) log(`Glide repack: ${completed}/${source.shards.length} source shards; ${prepared} exact records.`);
        });
        for (const result of results) {
            exact.update(result.digest); detail.push(...result.detail); masks.push(...result.masks); records += result.records;
        }
        const overview = await buildOverview(masks, source.coverage, zoom, cache, overviewImplementation, force, log);
        const files = new Map<string, Artifact>();
        const objectDirectory = path.join(cache, 'objects');
        const save = async (data: Buffer, kind: string, suffix = 'json'): Promise<Artifact> => {
            const sha256 = hash(data), item = { file: `${kind}/${sha256}.${suffix}`, bytes: data.length, sha256 };
            if (!await matchesFile(path.join(objectDirectory, item.file), item)) await writeFileAtomic(path.join(objectDirectory, item.file), data);
            files.set(item.file, item); return item;
        };
        const archives: Archive[] = [];
        for (const blocks of [detail, overview]) {
            const groups = new Map<string, StoredBlock[]>();
            for (const block of blocks) {
                const [z, x, y] = block.tile, root = packageRoot({ z, x, y }), key = `${z}/${root.z}/${root.x}/${root.y}`;
                if (!groups.has(key)) groups.set(key, []); groups.get(key)!.push(block);
            }
            for (const [, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
                group.sort((a, b) => a.tile[1] - b.tile[1] || a.tile[2] - b.tile[2] || a.key.localeCompare(b.key));
                let parts: { block: StoredBlock; data: Buffer }[] = [], size = 0;
                const flush = async () => {
                    if (!parts.length) return;
                    const encoded = encodeArchive(parts.map(({ block: { file: _, ...block }, data }) => ({ block, data })));
                    const entries = readArchiveDirectory(encoded.data);
                    if (JSON.stringify(entries) !== JSON.stringify(encoded.entries)) throw new Error('Archive directory round trip failed');
                    const kind = parts[0].block.kind, item = await save(encoded.data, kind, kind === 'detail' ? 'gld' : 'glo');
                    archives.push({ ...item, kind, bounds: unionBounds(parts.map(p => p.block.bounds)), blocks: entries });
                    parts = []; size = 0;
                };
                for (const block of group) {
                    const estimatedDirectory = jsonBytes({ ...block, offset: L.archiveBytes }).length + 2;
                    if (parts.length && (size + block.bytes + estimatedDirectory + 16 > L.archiveBytes || parts.length >= 128 || block.oversized || parts[0].block.oversized)) await flush();
                    const data = await fs.readFile(path.join(cache, block.file));
                    parts.push({ block, data }); size += block.bytes + estimatedDirectory;
                }
                await flush();
            }
        }
        log(`Glide archives: ${archives.length}; ${detail.filter(b => b.oversized).length} explicitly marked indivisible large polygons.`);
        async function pages(selected: Archive[]): Promise<Page[]> {
            const pages: Page[] = [];
            for (const kind of ['detail', 'overview'] as const) {
                let entries: Archive[] = [], bytes = 100;
                const flush = async () => {
                    if (!entries.length) return;
                    const data = jsonBytes({ schemaVersion: 1, kind, archives: entries });
                    validateIndex(JSON.parse(data.toString()));
                    if (data.length > L.pageBytes) throw new Error('Glide index exceeds page limit');
                    const item = await save(data, 'indexes');
                    pages.push({ ...item, bounds: unionBounds(entries.map(e => e.bounds)), entries: entries.length, kind });
                    entries = []; bytes = 100;
                };
                for (const entry of selected.filter(a => a.kind === kind)) {
                    const length = jsonBytes(entry).length + 1;
                    if (entries.length && (bytes + length > L.pageBytes || entries.length >= L.pageEntries)) await flush();
                    entries.push(entry); bytes += length;
                }
                await flush();
            }
            return pages;
        }
        const indexes = await pages(archives);
        const provenance = await save(await fs.readFile(path.join(input.directory, source.provenance.file)), 'provenance');
        const coverage = await save(jsonBytes({ schemaVersion: 1, meaning: 'source-region-coverage-not-per-pixel-assessment', regions: source.coverage }), 'coverage');
        const regionReferences: RegionReference[] = [];
        for (const region of regions) {
            const selected = archives.filter(a => region.bounds.some(b => intersects(a.bounds, b)));
            const localIndexes = await pages(selected);
            const state = glideRegionCoverage(region.bounds, source.coverage);
            const dependencies = [...new Map([...selected.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 })), ...localIndexes, coverage, provenance].map(f => [f.file, f])).values()];
            const filePages: Artifact[] = [];
            if (dependencies.length > L.pageEntries || jsonBytes(dependencies).length > L.pageBytes / 2) {
                for (let i = 0; i < dependencies.length; i += L.pageEntries) {
                    const page = { schemaVersion: 1, files: dependencies.slice(i, i + L.pageEntries) };
                    validateDependencyPage(page);
                    const bytes = jsonBytes(page);
                    if (bytes.length > L.pageBytes) throw new Error('Glide dependency page exceeds limit');
                    filePages.push(await save(bytes, 'dependencies'));
                }
            }
            const data = jsonBytes({ schemaVersion: 1, ...region, definitionSha256: hash(jsonBytes(region)), sourceSha256: input.manifestSha256,
                coverage: state, indexes: localIndexes, files: filePages.length ? [] : dependencies,
                ...(filePages.length ? { filePages } : {}) });
            validateRegionInventory(JSON.parse(data.toString()), dependencies);
            if (data.length > L.pageBytes) throw new Error(`Glide region inventory exceeds limit: ${region.id}`);
            const item = await save(data, 'regions');
            regionReferences.push({ ...item, id: region.id, bounds: region.bounds, coverage: state,
                downloadBytes: item.bytes + [...dependencies, ...filePages].reduce((n, f) => n + f.bytes, 0) });
        }
        const { shards: _, coverage: __, provenance: ___, ...sourceMetadata } = source;
        const manifest: DeliveryManifest = { product: 'glide-packages', schemaVersion: 1, generatedAt: source.generatedAt,
            inputSha256: input.manifestSha256, packagingSha256, source: sourceMetadata, provenance, coverage, indexes, regions: regionReferences,
            overview: { projection: 'EPSG:3857', tileSize: 256, samplesPerAxis: 4, minZoom: 0, maxZoom: zoom,
                encoding: 'uint8-preferred-best-effort-prepared', densityMeaning: 'sampled-ground-area-fraction', version: 1 },
            limits: L, totalBytes: 0, records, detailDigest: exact.digest('hex') };
        const artifactBytes = [...files.values()].reduce((n, f) => n + f.bytes, 0);
        for (let iteration = 0; iteration < 10; iteration++) {
            const total = artifactBytes + jsonBytes(manifest).length * 2;
            if (total === manifest.totalBytes) break; manifest.totalBytes = total;
        }
        const encoded = jsonBytes(manifest);
        validateDeliveryManifest(manifest);
        if (manifest.totalBytes !== artifactBytes + encoded.length * 2 || manifest.totalBytes > maxBytes) throw new Error(`Glide release exceeds byte budget: ${manifest.totalBytes} > ${maxBytes}; previous publication retained`);
        const snapshot = await save(encoded, 'snapshots');
        for (const item of files.values()) {
            const from = path.join(objectDirectory, item.file), to = path.join(directory, item.file);
            if (!await matchesFile(from, item)) throw new Error(`Invalid staged glide artifact: ${item.file}`);
            if (!await matchesFile(to, item)) await copyFileAtomic(from, to);
        }
        // Do not change discovery unless the entire graph and input records have passed verification.
        await writeFileAtomic(path.join(directory, 'manifest.json'), encoded);
        let storedBytes = 0;
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            if (entry.isFile()) storedBytes += (await fs.stat(path.join(directory, entry.name))).size;
            else if (entry.isDirectory()) for (const file of await fs.readdir(path.join(directory, entry.name))) {
                const stat = await fs.stat(path.join(directory, entry.name, file)); if (stat.isFile()) storedBytes += stat.size;
            }
        }
        const distribution = (values: number[]) => {
            values.sort((a, b) => a - b);
            const at = (fraction: number) => values[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? 0;
            return { p50: at(.5), p95: at(.95), p99: at(.99), max: at(1) };
        };
        const components = Object.fromEntries(['detail', 'overview', 'indexes', 'regions', 'dependencies', 'coverage', 'provenance', 'snapshots'].map(kind => [kind,
            [...files.values()].filter(f => f.file.startsWith(kind + '/')).reduce((n, f) => n + f.bytes, 0)]));
        const report = { source: input.manifestSha256, snapshot, totalBytes: manifest.totalBytes, records,
            storedBytes, retainedOrAdditionalBytes: storedBytes - manifest.totalBytes,
            components: { ...components, discovery: encoded.length },
            detailBlocks: detail.length, overviewTiles: overview.length, archives: archives.length,
            detailDistribution: { compressedBytes: distribution(detail.map(b => b.bytes)), rawBytes: distribution(detail.map(b => b.rawBytes)),
                vertices: distribution(detail.map(b => b.vertices)), records: distribution(detail.map(b => b.records)) },
            overviewLevels: Array.from({ length: zoom + 1 }, (_, z) => ({ zoom: z, tiles: overview.filter(b => b.tile[0] === z).length,
                compressedBytes: overview.filter(b => b.tile[0] === z).reduce((n, b) => n + b.bytes, 0) })),
            oversizedRecords: detail.filter(b => b.oversized).length,
            maxBlockVertices: detail.reduce((n, b) => Math.max(n, b.vertices), 0), maxBlockRawBytes: detail.reduce((n, b) => Math.max(n, b.rawBytes), 0),
            downloads: 0, analyzedChunks: 0, mode: options.reassemble ? 'reassemble' : 'repack',
            ...(source.reassembly ? { assemblyComparison: (source.reassembly as any).comparison } : {}),
            detailPreserved: true, detailDigest: manifest.detailDigest };
        await writeFileAtomic(path.join(cache, 'report.json'), jsonBytes(report));
        log(`Glide packages ready: ${manifest.totalBytes} bytes; ${records} exact records. Downloads: 0. Analyzed chunks: 0.`);
        return manifest;
    } finally { await release(); }
}

/** Retain every committed immutable snapshot. Remove only failed/unreferenced artifacts. */
export async function cleanGlidePackages(output: string): Promise<void> {
    const root = path.resolve(output), directory = path.join(root, 'charts/glide'), cache = path.join(root, 'glide-package-cache');
    const release = await acquireChartBuildLock(cache);
    try {
        const keep = new Set<string>(['manifest.json']);
        const visit = async (item: Artifact) => {
            if (!artifact(item)) throw new Error('Invalid glide cleanup dependency');
            if (keep.has(item.file)) return;
            if (!await matchesFile(path.join(directory, item.file), item)) throw new Error(`Incomplete glide publication; refusing cleanup: ${item.file}`);
            keep.add(item.file);
            if (item.file.endsWith('.json') && !item.file.startsWith('provenance/') && !item.file.startsWith('coverage/')) {
                await walk(JSON.parse(await fs.readFile(path.join(directory, item.file), 'utf8')));
            }
        };
        const walk = async (value: unknown): Promise<void> => {
            if (!value || typeof value !== 'object') return;
            if (artifact(value)) { await visit(value as Artifact); return; }
            for (const child of Object.values(value)) await walk(child);
        };
        const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
        validateDeliveryManifest(manifest);
        await walk(manifest);
        for (const name of await fs.readdir(path.join(directory, 'snapshots'))) {
            if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error('Unrecognized glide snapshot');
            const data = await fs.readFile(path.join(directory, 'snapshots', name));
            await visit({ file: `snapshots/${name}`, sha256: name.slice(0, 64), bytes: data.length });
        }
        for (const folder of ['detail', 'overview', 'indexes', 'regions', 'dependencies', 'coverage', 'provenance']) {
            for (const name of await fs.readdir(path.join(directory, folder)).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
                const file = `${folder}/${name}`;
                if (/^[a-f0-9]{64}\.(json|gld|glo)$/.test(name) && !keep.has(file)) await fs.rm(path.join(directory, file));
            }
        }
    } finally { await release(); }
}
