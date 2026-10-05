import fs from 'node:fs/promises';
import path from 'node:path';
import { hash, intersects, DELIVERY_LIMITS as L, type Archive, type Artifact, type Page } from './glide-delivery.ts';
import { validateDeliveryManifest, validateDependencyPage, validateIndex, validateRegionInventory } from './glide-package-validation.ts';
import { decodeDetail, inflateBlock, readArchiveDirectory } from './glide-package-archive.ts';
import { checkPackagePaths } from './glide-package-input.ts';
import { copyFileAtomic } from './fs-utils.ts';

/** Independent delivery-graph verification, with no analysis inputs or engine dependency. */
export async function verifyGlidePackages(output: string, log: (message: string) => void = console.log, onArtifact?: (item: Artifact) => void) {
    const directory = path.join(path.resolve(output), 'charts/glide'), rawManifest = await fs.readFile(path.join(directory, 'manifest.json'));
    const manifest = JSON.parse(rawManifest.toString()); validateDeliveryManifest(manifest);
    const files = new Map<string, Artifact>(), archives = new Map<string, Archive>(), decoded = new Map<string, Uint32Array>();
    const overviewKeys = new Set<string>(), sourceCounts = new Map<string, { count: number; maximum: number }>();
    let records = 0, blocks = 0, overviewTiles = 0, oversized = 0;
    const read = async (item: Artifact) => {
        const previous = files.get(item.file);
        if (previous && (previous.sha256 !== item.sha256 || previous.bytes !== item.bytes)) throw new Error(`Conflicting identity for ${item.file}`);
        const data = await fs.readFile(path.join(directory, item.file));
        if (data.length !== item.bytes || hash(data) !== item.sha256) throw new Error(`Glide artifact verification failed: ${item.file}`);
        files.set(item.file, item); return data;
    };
    const visitPage = async (page: Page, global: boolean) => {
        const value = JSON.parse((await read(page)).toString()); validateIndex(value, page);
        for (const archive of value.archives) {
            if (!global && !archives.has(archive.file)) throw new Error('Regional index references an archive absent from the global inventory');
            const previous = archives.get(archive.file);
            if (previous) {
                if (JSON.stringify(previous) !== JSON.stringify(archive)) throw new Error('Conflicting archive index entries');
                continue;
            }
            archives.set(archive.file, archive);
            const data = await read(archive), entries = readArchiveDirectory(data);
            if (JSON.stringify(entries) !== JSON.stringify(archive.blocks)) throw new Error('Archive directory disagrees with spatial index');
            for (const block of entries) {
                const bytes = data.subarray(block.offset, block.offset + block.bytes); blocks++;
                if (block.kind === 'detail') {
                    const detail = decodeDetail(bytes, block);
                    if (!block.key.startsWith(detail.source + '/')) throw new Error('Source identity disagrees with block key');
                    if (decoded.size >= 10_000 && !decoded.has(detail.source)) throw new Error('Too many original sources');
                    let seen = decoded.get(detail.source);
                    if (!seen) decoded.set(detail.source, seen = new Uint32Array(3125));
                    for (const index of detail.indices) {
                        const bit = 1 << (index % 32), word = Math.floor(index / 32);
                        if (seen[word] & bit) throw new Error(`Duplicate original record ${detail.source}:${index}`);
                        seen[word] |= bit;
                    }
                    const counts = sourceCounts.get(detail.source) ?? { count: 0, maximum: -1 };
                    counts.count += detail.indices.length;
                    counts.maximum = Math.max(counts.maximum, ...detail.indices); sourceCounts.set(detail.source, counts);
                    records += detail.areas.length; oversized += Number(block.oversized === true);
                } else {
                    const address = block.tile.join('/');
                    if (block.key !== address || overviewKeys.has(address) || block.tile[0] > manifest.overview.maxZoom) throw new Error('Duplicate/invalid overview tile');
                    overviewKeys.add(address);
                    const raw = inflateBlock(bytes, block);
                    for (let i = 0; i < raw.length; i += 3) if (raw[i] + raw[i + 1] > raw[i + 2]) throw new Error('Invalid numeric overview coverage');
                    overviewTiles++;
                }
            }
            if (archives.size % 200 === 0) log(`Glide verify: ${archives.size} archives, ${records} records.`);
        }
    };
    await read(manifest.provenance); await read(manifest.coverage);
    for (const page of manifest.indexes) await visitPage(page, true);
    for (const region of manifest.regions) {
        const value = JSON.parse((await read(region)).toString()); validateRegionInventory(value);
        if (value.id !== region.id || JSON.stringify(value.bounds) !== JSON.stringify(region.bounds) || value.coverage !== region.coverage ||
            value.sourceSha256 !== manifest.inputSha256) throw new Error('Region inventory disagrees with discovery');
        const dependencies: Artifact[] = [...value.files], dependencyPages: Artifact[] = value.filePages ?? [];
        if (new Set(dependencyPages.map(f => f.file)).size !== dependencyPages.length) throw new Error('Duplicate dependency page');
        for (const page of dependencyPages) {
            const content = JSON.parse((await read(page)).toString()); validateDependencyPage(content);
            dependencies.push(...content.files);
        }
        validateRegionInventory(value, dependencies);
        const available = new Set(dependencies.map(f => f.file)), selected = new Set<string>();
        for (const page of value.indexes) {
            await visitPage(page, false);
            const index = JSON.parse((await read(page)).toString());
            for (const archive of index.archives) {
                if (!available.has(archive.file)) throw new Error('Region omits required archive');
                selected.add(archive.file);
            }
        }
        const expectedFiles = new Set<string>([manifest.coverage.file, manifest.provenance.file, ...value.indexes.map((p: Page) => p.file)]);
        for (const archive of archives.values()) if (region.bounds.some(b => intersects(b, archive.bounds))) {
            if (!selected.has(archive.file)) throw new Error('Region omits intersecting archive');
            expectedFiles.add(archive.file);
        }
        if (available.size !== expectedFiles.size || [...expectedFiles].some(f => !available.has(f))) throw new Error('Incomplete/extra region dependencies');
        for (const file of dependencies) {
            const known = files.get(file.file);
            if (!known) await read(file);
            else if (known.bytes !== file.bytes || known.sha256 !== file.sha256) throw new Error('Conflicting region dependency');
        }
        const expected = region.bytes + [...dependencies, ...dependencyPages].reduce((n, f) => n + f.bytes, 0);
        if (expected !== region.downloadBytes) throw new Error('Region download accounting mismatch');
    }
    const sha256 = hash(rawManifest);
    if ([...sourceCounts.values()].some(c => c.maximum + 1 !== c.count)) throw new Error('Missing original record index');
    await read({ file: `snapshots/${sha256}.json`, bytes: rawManifest.length, sha256 });
    const bytes = rawManifest.length + [...files.values()].reduce((n, f) => n + f.bytes, 0);
    if (bytes !== manifest.totalBytes || bytes >= L.releaseBytes || records !== manifest.records) throw new Error('Glide release byte/record accounting mismatch');
    const result = { bytes, records, archives: archives.size, blocks, overviewTiles, oversizedRecords: oversized, files: files.size + 1 };
    for (const file of files.values()) onArtifact?.(file);
    onArtifact?.({ file: 'manifest.json', bytes: rawManifest.length, sha256 });
    log(`Glide verified: ${JSON.stringify(result)}`); return result;
}

/** Export exactly one verified release, excluding retained generations and build caches. */
export async function exportGlidePackages(output: string, destination: string, log: (message: string) => void = console.log) {
    const source = path.join(path.resolve(output), 'charts/glide'), target = path.join(path.resolve(destination), 'charts/glide');
    await checkPackagePaths(path.join(source, 'manifest.json'), destination);
    try { await fs.stat(target); throw new Error('Active export requires a new output directory'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const artifacts: Artifact[] = [], result = await verifyGlidePackages(output, log, item => artifacts.push(item));
    await fs.mkdir(path.dirname(target), { recursive: true });
    const staging = await fs.mkdtemp(path.join(path.dirname(target), '.glide-export-'));
    try {
        const directories = new Set([staging]);
        for (const item of artifacts) {
            const to = path.join(staging, item.file); await copyFileAtomic(path.join(source, item.file), to);
            const bytes = await fs.readFile(to);
            if (bytes.length !== item.bytes || hash(bytes) !== item.sha256) throw new Error('Publication changed during export');
            await fs.chmod(to, 0o644);
            directories.add(path.dirname(to));
        }
        // mkdtemp creates 0700; published files must remain readable after rsync.
        for (const directory of directories) await fs.chmod(directory, 0o755);
        await fs.rename(staging, target);
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
    log(`Glide active export: ${target}; ${result.bytes} bytes including discovery and pinned snapshot.`);
    return result;
}
