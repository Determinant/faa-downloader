import fs from 'node:fs/promises';
import path from 'node:path';
import { acquireChartBuildLock, recoverPendingChartLock } from './chart-build-lock.ts';
import { pdfBookFolder } from './pdf-layout.ts';
import { DEFAULT_RETAIN_CYCLES, isCycle, parseRetainCycles, productCycleWindow } from './cycle-retention.ts';
import { parseSupplementDateCode, supplementDateCode } from './chart-supplements.ts';

export { DEFAULT_RETAIN_CYCLES as DEFAULT_RETAIN_CHART_CYCLES, parseRetainCycles as parseRetainChartCycles };

async function stat(file: string) {
    try { return await fs.lstat(file); }
    catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function entries(directory: string) {
    const info = await stat(directory);
    if (!info) return [];
    if (!info.isDirectory()) throw new Error(`Expected retention directory: ${directory}`);
    return fs.readdir(directory, { withFileTypes: true });
}

async function readJson(file: string) {
    if (!(await stat(file))?.isFile()) throw new Error(`Missing retention metadata: ${file}`);
    return JSON.parse(await fs.readFile(file, 'utf8'));
}

/** Run only after a successful complete build, serialized with other builders
 * and uploads. Product dates differ: raster editions and catalog revisions each
 * get their own window. Retained catalogs pin exact older PDF dependencies.
 */
export async function pruneChartCycles(output: string, retainCycles: number, through: string): Promise<void> {
    parseRetainCycles(String(retainCycles));
    if (!isCycle(through)) throw new Error(`Invalid retention cutoff: ${through}`);
    const root = path.resolve(output);
    const charts = path.join(root, 'charts');
    const cycles = [...new Set((await Promise.all(['charts', 'sources', 'mbtiles', 'zips']
        .map(folder => entries(path.join(root, folder)))))
        .flat().filter(entry => entry.isDirectory() && isCycle(entry.name)).map(entry => entry.name))]
        .sort().reverse();
    if (!cycles.length) return;

    const releases: Array<() => Promise<void>> = [];
    const ownedLocks = new Set<string>();
    const lock = async (base: string) => {
        releases.push(await acquireChartBuildLock(base));
        ownedLocks.add(`${base}.build.lock`);
    };
    try {
        await lock(path.join(charts, '.navigation'));
        // Lock catalogs before resolving cross-cycle book references, and hold
        // package locks until deletion finishes. Fail before deleting anything
        // if a standalone publisher is still using any of these products.
        for (const cycle of cycles) {
            for (const folder of ['charts', 'sources', 'mbtiles', 'zips']) await entries(path.join(root, folder, cycle));
            if (await stat(path.join(root, 'sources', cycle, 'tpp'))) {
                await entries(path.join(root, 'sources', cycle, 'tpp'));
                await lock(path.join(root, 'sources', cycle, 'tpp'));
            }
            if (!(await stat(path.join(charts, cycle)))?.isDirectory()) continue;
            for (const family of ['tpp', 'cs', 'mbtiles']) {
                const directory = path.join(charts, cycle, family);
                await entries(directory); // Reject symlinked product directories.
                if (await stat(directory)) await lock(family === 'mbtiles'
                    ? path.join(directory, 'packages') : path.join(charts, cycle, `.${family}`));
            }
        }

        const cutoffs = new Map<string, string>();
        for (const family of ['mbtiles', 'tpp', 'cs', 'nav'] as const) {
            const { oldest } = await productCycleWindow(root, family, retainCycles, through);
            if (oldest) cutoffs.set(family, oldest);
        }

        const pinnedBooks = new Set<string>();
        const pinnedSources = new Set<string>();
        const pinnedSupplementIndexes = new Set<string>();
        for (const cycle of cycles) for (const family of ['tpp', 'cs']) {
            const cutoff = cutoffs.get(family);
            if (cutoff && cycle < cutoff) continue;
            const directory = path.join(charts, cycle, family);
            const pointer = path.join(directory, family === 'cs' ? 'catalog.json' : 'manifest.json');
            if (!await stat(pointer)) continue;
            let catalog = await readJson(pointer);
            if (family === 'tpp') {
                if (typeof catalog.file !== 'string' || !/^catalog(?:\.[a-f0-9]{64})?\.json$/.test(catalog.file)) {
                    throw new Error(`Invalid TPP retention manifest: ${pointer}`);
                }
                catalog = await readJson(path.join(directory, catalog.file));
            }
            if (!Array.isArray(catalog.volumes)) throw new Error(`Invalid PDF retention catalog: ${pointer}`);
            if (family === 'cs' && isCycle(catalog.effectiveDate)) {
                pinnedSupplementIndexes.add(`afd_${supplementDateCode(catalog.effectiveDate)}.xml`);
            }
            for (const volume of catalog.volumes) {
                if (typeof volume.url !== 'string' || path.isAbsolute(volume.url) || volume.url.includes('://')) {
                    throw new Error(`Invalid retained PDF URL in ${pointer}`);
                }
                const book = path.resolve(directory, volume.url);
                const relative = path.relative(charts, book).split(path.sep);
                if (relative.length !== 3 || !isCycle(relative[0]) ||
                    pdfBookFolder(relative[2]) !== relative[1]) throw new Error(`Invalid retained PDF path: ${book}`);
                await entries(path.dirname(book));
                const info = await stat(book);
                if (!info?.isFile() || info.size !== volume.byteLength) throw new Error(`Missing or invalid retained PDF: ${book}`);
                pinnedBooks.add(book);
                const source = path.join(root, 'sources', relative[0], relative[1],
                    relative[2].replace(/\.[a-f0-9]{64}\.pdf$/i, '.pdf'));
                pinnedSources.add(source);
                pinnedSources.add(path.join(root, 'sources', relative[0], `${path.basename(source)}.http.json`));
            }
        }

        // Validate retained raster manifests before their dates can authorize
        // removal of older complete packages and expensive source caches.
        const rasterCutoff = cutoffs.get('mbtiles');
        if (rasterCutoff) for (const cycle of cycles.filter(cycle => cycle >= rasterCutoff && cycle <= through)) {
            const directory = path.join(charts, cycle, 'mbtiles');
            const pointer = path.join(directory, 'manifest.json');
            if (!await stat(pointer)) continue;
            const manifest = await readJson(pointer);
            if (!Array.isArray(manifest.archives) || !manifest.archives.length) {
                throw new Error(`Invalid raster retention manifest: ${pointer}`);
            }
            for (const archive of manifest.archives) {
                if (typeof archive.file !== 'string' || path.basename(archive.file) !== archive.file ||
                    !archive.file.endsWith('.mbtiles')) throw new Error(`Invalid retained archive in ${pointer}`);
                const info = await stat(path.join(directory, archive.file));
                if (!info?.isFile() || info.size !== archive.byteLength) {
                    throw new Error(`Missing or invalid retained archive: ${archive.file}`);
                }
            }
        }

        const removals: string[] = [];
        const emptyDirectories = new Set<string>();
        const plan = async (directory: string, keep = new Set<string>()) => {
            for (const entry of await entries(directory)) {
                const file = path.join(directory, entry.name);
                if (ownedLocks.has(file)) continue;
                if (/\.build\.lock\.pending-/.test(entry.name)) {
                    await recoverPendingChartLock(file);
                    continue;
                }
                if (entry.name.endsWith('.build.lock')) {
                    await lock(file.slice(0, -'.build.lock'.length));
                    continue;
                }
                if (entry.isDirectory()) await plan(file, keep);
                else if (!keep.has(file)) removals.push(file);
            }
            emptyDirectories.add(directory);
        };
        for (const cycle of cycles.filter(cycle => cycle <= through)) {
            if (rasterCutoff && cycle < rasterCutoff) {
                for (const directory of [path.join(charts, cycle, 'mbtiles'), path.join(root, 'mbtiles', cycle),
                    path.join(root, 'sources', cycle, 'charts'), path.join(root, 'zips', cycle)]) await plan(directory);
                for (const entry of await entries(path.join(root, 'sources', cycle))) {
                    if (entry.isFile() && entry.name.endsWith('.zip.http.json')) {
                        removals.push(path.join(root, 'sources', cycle, entry.name));
                    }
                }
            }
            if (cutoffs.get('nav') && cycle < cutoffs.get('nav')!) {
                await plan(path.join(charts, cycle, 'nav'));
                await plan(path.join(root, 'sources', cycle, 'nav'));
            }
            for (const family of ['tpp', 'cs']) {
                const cutoff = cutoffs.get(family);
                if (!cutoff || cycle >= cutoff) continue;
                await plan(path.join(charts, cycle, family), pinnedBooks);
                await plan(path.join(root, 'sources', cycle, family), pinnedSources);
                for (const entry of await entries(path.join(root, 'sources', cycle))) {
                    const file = path.join(root, 'sources', cycle, entry.name);
                    if (entry.isFile() && entry.name.endsWith('.http.json') &&
                        pdfBookFolder(entry.name.slice(0, -'.http.json'.length)) === family && !pinnedSources.has(file)) removals.push(file);
                }
                if (family === 'cs') removals.push(path.join(root, 'supplements', `${cycle}.build.json`));
            }
            for (const folder of ['charts', 'sources', 'mbtiles', 'zips']) emptyDirectories.add(path.join(root, folder, cycle));
        }
        // XML publication dates can differ from their catalog revision dates.
        const supplementCutoff = cutoffs.get('cs');
        if (supplementCutoff) for (const entry of await entries(path.join(root, 'supplements'))) {
            const match = entry.name.match(/^(afd_(\d{2}[A-Z]{3}\d{4})\.xml)(?:\.http\.json|\.part(?:\.http\.json)?)?$/);
            if (!entry.isFile() || !match || pinnedSupplementIndexes.has(match[1])) continue;
            const date = parseSupplementDateCode(match[2]);
            if (date && date < supplementCutoff) removals.push(path.join(root, 'supplements', entry.name));
        }
        // PDF page indexes follow every surviving immutable book, including saved URL snapshots.
        const removed = new Set(removals);
        const bookHashes = new Set<string>();
        for (const cycle of cycles) for (const family of ['tpp', 'cs']) {
            for (const entry of await entries(path.join(charts, cycle, family))) {
                const hash = entry.name.match(/\.([a-f0-9]{64})\.pdf$/i)?.[1];
                if (hash && !removed.has(path.join(charts, cycle, family, entry.name))) bookHashes.add(hash);
            }
        }
        for (const entry of await entries(path.join(root, 'pdf-indexes'))) {
            const hash = entry.name.match(/^([a-f0-9]{64})\.(?:tpp|cs)\.json(?:\.build\.json)?$/)?.[1];
            if (entry.isFile() && hash && !bookHashes.has(hash)) removals.push(path.join(root, 'pdf-indexes', entry.name));
        }
        // All reference/lock checks above complete before the first deletion.
        for (const file of removals) await fs.rm(file, { force: true });
        for (const release of releases.splice(0).reverse()) await release();
        for (const directory of [...emptyDirectories].sort((a, b) => b.length - a.length)) {
            await fs.rmdir(directory).catch((error: any) => {
                if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
            });
        }
        if (removals.length) console.log(`Pruned ${removals.length} expired chart/cache files (retaining ${retainCycles} editions per product)`);
    } finally {
        for (const release of releases.reverse()) await release();
    }
}
