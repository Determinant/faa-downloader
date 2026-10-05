import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { copyFileAtomic, writeFileAtomic } from './fs-utils.ts';
import { matchesFile } from './build-cache.ts';
import { contains, hash, inspectArea, jsonBytes, validateSource, type Area, type SourceManifest, type SourceShard } from './glide-delivery.ts';

export type PinnedInput = { manifest: SourceManifest; directory: string; manifestSha256: string; sourceFile: string };
/** Reflink/copy before verification: atomic replacement and in-place edits cannot change pinned bytes. */
export async function pinGlideInput(inputFile: string, cache: string, log: (message: string) => void): Promise<PinnedInput> {
    const bytes = await fs.readFile(inputFile);
    if (bytes.length > 8 * 1024 * 1024) throw new Error('Glide input manifest exceeds limit');
    const manifest: unknown = JSON.parse(bytes.toString()); validateSource(manifest);
    const manifestSha256 = hash(bytes), directory = path.join(cache, 'inputs', manifestSha256);
    await fs.mkdir(directory, { recursive: true });
    let checked = 0;
    for (const item of [manifest.provenance, ...manifest.shards]) {
        const target = path.join(directory, item.file);
        if (!await matchesFile(target, item)) {
            await copyFileAtomic(path.resolve(path.dirname(inputFile), item.file), target);
            if (!await matchesFile(target, item)) throw new Error(`Invalid/missing pinned glide input: ${item.file}; no analysis will be run`);
        }
        if (++checked % 200 === 0) log(`Glide input: ${checked}/${manifest.shards.length + 1} files pinned and verified.`);
    }
    await writeFileAtomic(path.join(directory, 'manifest.json'), bytes);
    return { manifest, directory, manifestSha256, sourceFile: path.resolve(inputFile) };
}
export async function readSourceShard(input: PinnedInput, shard: SourceShard): Promise<Area[]> {
    const compressed = await fs.readFile(path.join(input.directory, shard.file));
    if (compressed.length !== shard.bytes || hash(compressed) !== shard.sha256) throw new Error(`Source shard changed: ${shard.file}`);
    const raw = gunzipSync(compressed, { maxOutputLength: shard.rawBytes });
    if (raw.length !== shard.rawBytes) throw new Error('Source raw byte count mismatch');
    const areas = JSON.parse(raw.toString());
    if (!Array.isArray(areas) || areas.length !== shard.count) throw new Error('Source record count mismatch');
    const tiers = [0, 0];
    for (const area of areas) {
        const info = inspectArea(area, input.manifest.schemaVersion);
        if (!contains(shard.bounds, info.bounds)) throw new Error('Source shard bounds omit a polygon');
        tiers[area[0][7] - 1]++;
    }
    if (tiers.some((n, i) => n !== shard.tiers[i])) throw new Error('Source tier counts mismatch');
    return areas;
}
/** Resolve existing ancestors too, so a symlink cannot route output over an input. */
export async function canonicalPath(file: string): Promise<string> {
    try { return await fs.realpath(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return path.join(await canonicalPath(path.dirname(file)), path.basename(file)); }
}
export async function checkPackagePaths(inputFile: string, output: string): Promise<void> {
    const source = await canonicalPath(path.dirname(path.resolve(inputFile))), target = await canonicalPath(path.resolve(output));
    const actualManifestDirectory = path.dirname(await canonicalPath(path.resolve(inputFile)));
    const within = (a: string, b: string) => a === b || b.startsWith(a + path.sep);
    // A new output root inside dist is fine; an output root containing source files is not.
    if ([source, actualManifestDirectory].some(directory => within(target, directory) || within(directory, target))) throw new Error('Choose a separate --output root that does not overlap the input directory');
}
