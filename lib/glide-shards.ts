import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { glideAreaBounds, glideAreaPolygon } from './glide-areas.ts';
import { mergeGlideLandingAreasIndexed, UNQUALIFIED_GLIDE_UNION } from './glide-merge.ts';
import { recoverGlidePrecision } from './glide-precision.ts';
import { gdalCommand } from './gdal.ts';
import type { Bounds, GlideLandingArea } from './glide-model.ts';

// Packaging has its own identity: changing file boundaries must not invalidate
// expensive terrain/cover/hazard checkpoints or change the wire schema.
export const GLIDE_SHARD_POLICY = {
    strategy: 'bounded-spatial-v1', mergeRawBytes: 8 * 1024 * 1024,
    maxRawBytes: 16 * 1024 * 1024, maxBytes: 2 * 1024 * 1024, maxRecords: 100_000,
} as const;
// Version 3 checks union completeness and cleans precision defects.
// Valid version-2 batches can be adopted after validating their original patches.
export const GLIDE_DELIVERY_VERSION = 3;
type Limits = { maxRawBytes: number; maxBytes: number; maxRecords: number };
export type EncodedGlideShard = {
    id: string; bounds: Bounds; count: number; tiers: [number, number]; rawBytes: number; data: Buffer;
};
const compress = promisify(gzip);
export class InvalidGlideGeometry extends Error {
    readonly patches: { index: number; reason: string; fit: number[] }[];
    constructor(patches: { index: number; reason: string }[], records: GlideLandingArea[], recovery?: string) {
        const { index, reason } = patches[0], fit = records[index][0];
        super(`Invalid quantized glide polygon at patch ${index}, fit ${fit.slice(0, 4).join(',')} (${reason}; ` +
            `${patches.length} invalid patches); refusing to publish invalid geometry. ` +
            'Analysis checkpoints and the previous publication are retained.' + (recovery ? ` ${recovery}` : ''));
        this.patches = patches.map(patch => ({ ...patch, fit: records[patch.index][0].slice(0, 4) }));
    }
}

/** Saved analysis is immutable. Correct only invalid delivery copies, and only
 * when the exact quantized result remains inside the shell minus every hole
 * and contains the full original fit. Disconnected pieces without that fit, and
 * invalid patches with no surviving full fit, are omitted from delivery. */
export async function prepareGlideShardPatches(records: GlideLandingArea[],
    log: (message: string) => void = () => {}): Promise<GlideLandingArea[]> {
    try { await validateGlideShardPatches(records); return records; }
    catch (error) {
        if (!(error instanceof InvalidGlideGeometry)) throw error;
        const result = records.slice(), omitted = new Set<GlideLandingArea>(), messages: string[] = [];
        const unrecoverable: typeof error.patches = [];
        for (const patch of error.patches) {
            if (!/^(?:(?:Ring )?Self-intersection|Interior is disconnected|Hole lies outside shell|Holes are nested|Too few points)/.test(patch.reason)) { unrecoverable.push(patch); continue; }
            const recovered = await recoverGlidePrecision(records[patch.index]);
            if (!recovered) {
                omitted.add(records[patch.index]);
                messages.push(`geometry cleanup omitted invalid patch for fit ${records[patch.index][0].slice(0, 4).join(',')}; ` +
                    'no valid connected piece retains the full fit and exclusions.');
                continue;
            }
            result[patch.index] = recovered.area;
            messages.push(`geometry cleanup for fit ${records[patch.index][0].slice(0, 4).join(',')}; ` +
                `${(recovered.removedFraction * 100).toFixed(4)}% area removed; full fit and exclusions retained.`);
        }
        if (unrecoverable.length) throw new InvalidGlideGeometry(unrecoverable, records, 'Unsupported geometry defect.');
        const cleaned = result.filter(record => !omitted.has(record));
        await validateGlideShardPatches(cleaned);
        for (const message of messages) log(message);
        return cleaned;
    }
}

/** Validate the exact quantized polygons consumers receive, including holes.
 * Never repair by filling exclusions or attaching a fit to a disconnected fragment. */
export async function validateGlideShardPatches(records: GlideLandingArea[]): Promise<void> {
    if (!records.length) return;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'glide-geometry-'));
    try {
        const input = path.join(directory, 'patches.geojson'), output = path.join(directory, 'invalid.geojson');
        await fs.writeFile(input, JSON.stringify({ type: 'FeatureCollection', features: records.map((record, index) =>
            ({ type: 'Feature', properties: { patch: index }, geometry: glideAreaPolygon(record) })) }));
        await gdalCommand('ogr2ogr', ['-f', 'GeoJSON', '-dialect', 'SQLite', '-sql',
            'SELECT patch, ST_IsValidReason(geometry) AS reason FROM patches ' +
            'WHERE ST_IsValid(geometry) IS NOT 1 OR ST_IsEmpty(geometry) IS NOT 0', output, input]);
        const invalid = JSON.parse(await fs.readFile(output, 'utf8')).features;
        if (invalid.length) throw new InvalidGlideGeometry(invalid.map(({ properties }) =>
            ({ index: properties.patch, reason: properties.reason })), records);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

/** Union is a delivery optimization. Preserve the cleaned qualified geometry if
 * the union is null or a new tiny ring cannot survive the wire format's precision.
 * Do not erase exclusions or hide unrelated failures; leave analysis identities alone. */
export async function mergeGlideShardPatches(patches: GlideLandingArea[], directory: string,
    log: (message: string) => void = () => {}): Promise<GlideLandingArea[]> {
    // Clean before union: an invalid input may otherwise produce a plausible
    // union that silently loses components or restores an excluded sliver.
    patches = await prepareGlideShardPatches(patches, log);
    const retained = new Set<GlideLandingArea>();
    return mergeGlideLandingAreasIndexed(patches, directory, async (group, error, bounds) => {
        if (!(error instanceof Error)) throw error;
        // ST_Union can return NULL without GDAL rejecting the command. Keep
        // this recovery at the packaging boundary: editing the shared encoder
        // would invalidate completed analysis checkpoints. Match the exact
        // encoder failure, never a TypeError from input handling or GDAL itself.
        const nullGeometry = error instanceof TypeError && error.message === "Cannot read properties of null (reading 'type')" &&
            /^\s+at encodePolygon \(.+[/\\]glide-areas\.ts:\d+:\d+\)$/.test(error.stack?.split('\n')[1] ?? '');
        const unqualified = error.message === UNQUALIFIED_GLIDE_UNION;
        if (!nullGeometry && !unqualified && error.message !== 'Glide polygon collapsed during quantization') throw error;
        const originals = bounds ? overlappingOriginals(group.map(record => ({ record, bounds: glideAreaBounds([record]) })),
            bounds, group[0][2]) : group;
        if (!originals.length) throw error;
        await validateGlideShardPatches(originals);
        log(`union produced ${nullGeometry ? 'a null geometry' : unqualified ? 'a component without a qualification' : 'a ring below coordinate precision'}; ` +
            `retaining ${originals.length} validated original patches for the affected ${bounds ? 'polygon' : 'quality group'}.`);
        return originals.filter(record => {
            if (retained.has(record)) return false;
            retained.add(record); return true;
        });
    });
}

function overlappingOriginals(originals: { record: GlideLandingArea; bounds: Bounds }[], bounds: Bounds,
    flags: number): GlideLandingArea[] {
    return originals.filter(p => (p.record[2] & ~1) === (flags & ~1) &&
        p.bounds[0] <= bounds[2] && p.bounds[2] >= bounds[0] &&
        p.bounds[1] <= bounds[3] && p.bounds[3] >= bounds[1]).map(p => p.record);
}

/** Region/chunk order is spatial and stable. Never load a whole dense degree at once. */
export async function* readGlidePatchBatches(files: string[], maxRawBytes: number = GLIDE_SHARD_POLICY.mergeRawBytes,
    maxRecords: number = GLIDE_SHARD_POLICY.maxRecords): AsyncGenerator<GlideLandingArea[]> {
    let records: GlideLandingArea[] = [], bytes = 2;
    for (const file of files) {
        const input = createReadStream(file), lines = createInterface({ input, crlfDelay: Infinity });
        try {
            for await (const line of lines) {
                if (!line.trim()) continue;
                const size = Buffer.byteLength(line) + 1;
                if (records.length && (bytes + size > maxRawBytes || records.length >= maxRecords)) {
                    yield records;
                    records = []; bytes = 2;
                }
                records.push(JSON.parse(line)); bytes += size;
            }
        } finally { lines.close(); input.destroy(); }
    }
    if (records.length) yield records;
}

class OversizedGlideArea extends Error {
    constructor(id: string, readonly record: GlideLandingArea) {
        super(`Glide area in ${id} exceeds a shard size limit by itself; cannot split its polygon without requalification`);
    }
}

/** Split collections of whole polygons; clipping could detach ground from its qualification. */
async function encode(id: string, records: GlideLandingArea[], limits: Limits): Promise<EncodedGlideShard[]> {
    if (!records.length) return [];
    const raw = Buffer.from(JSON.stringify(records) + '\n');
    // Avoid spending compression time on a collection already known to need splitting.
    if (raw.length <= limits.maxRawBytes && records.length <= limits.maxRecords) {
        const data = await compress(raw, { level: 9 });
        if (data.length <= limits.maxBytes) {
            const tiers: [number, number] = [0, 0];
            for (const record of records) tiers[record[0][7] - 1]++;
            return [{ id, bounds: glideAreaBounds(records), count: records.length, tiers, rawBytes: raw.length, data }];
        }
    }
    if (records.length === 1) throw new OversizedGlideArea(id, records[0]);
    const center = (record: GlideLandingArea, axis: number) => (record[0][axis] + record[0][axis + 2]) / 2;
    const bounds: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
    for (const record of records) for (let axis = 0; axis < 2; axis++) {
        const value = center(record, axis);
        bounds[axis] = Math.min(bounds[axis], value); bounds[axis + 2] = Math.max(bounds[axis + 2], value);
    }
    const longitudeScale = Math.cos((bounds[1] + bounds[3]) / 2e6 * Math.PI / 180);
    const axis = (bounds[2] - bounds[0]) * longitudeScale >= bounds[3] - bounds[1] ? 0 : 1;
    // Stable median split also makes progress for coincident witness midpoints.
    const sorted = records.slice().sort((a, b) => center(a, axis) - center(b, axis) || center(a, 1 - axis) - center(b, 1 - axis));
    const middle = Math.floor(sorted.length / 2);
    const left = await encode(`${id}-0`, sorted.slice(0, middle), limits);
    const right = await encode(`${id}-1`, sorted.slice(middle), limits);
    return [...left, ...right];
}

export async function encodeGlideShards(id: string, records: GlideLandingArea[],
    unmerged?: GlideLandingArea[], limits: Limits = GLIDE_SHARD_POLICY,
    log: (message: string) => void = () => {}): Promise<EncodedGlideShard[]> {
    let candidates = records;
    const merged = new Set(records), replaced = new Set<GlideLandingArea>(), retained = new Set<GlideLandingArea>();
    const prepared = new Map<GlideLandingArea, GlideLandingArea>();
    let originals: { record: GlideLandingArea; bounds: Bounds }[] | undefined;
    for (;;) {
        try {
            const shards = await encode(id, candidates, limits);
            await validateGlideShardPatches(candidates);
            if (replaced.size) log(`retained ${records.length - replaced.size} merged polygons; replaced ${replaced.size} ` +
                `invalid or oversized unions with ${retained.size} validated original patches.`);
            return shards;
        }
        catch (error) {
            if (!(error instanceof OversizedGlideArea || error instanceof InvalidGlideGeometry)
                || !unmerged || unmerged === records) throw error;
            const failed = error instanceof OversizedGlideArea ? [error.record] : error.patches.map(p => candidates[p.index]);
            // Recover only failed unions. An unrelated original can be invalid
            // even though its union is valid; reverting the whole batch revives
            // that defect. Never retry an original that itself failed validation
            // or size limits, and never mutate its geometry/fit/flags.
            if (failed.some(record => !merged.has(record) || replaced.has(record) || retained.has(record))) throw error;
            originals ??= unmerged.map(record => ({ record, bounds: glideAreaBounds([record]) }));
            const selected = new Set<GlideLandingArea>();
            for (const record of failed) {
                const bounds = glideAreaBounds([record]);
                // Every contributor intersects the union's envelope. Include
                // all such originals of the same merge quality, even those
                // whose witness lies elsewhere. False positives only duplicate
                // already qualified ground; a midpoint match could omit lobes.
                const matches = overlappingOriginals(originals, bounds, record[2]);
                if (!matches.length) throw error;
                for (const p of matches) selected.add(p);
            }
            const selectedRecords = [...selected], qualified = await prepareGlideShardPatches(selectedRecords, log);
            // Cleanup preserves the original fit array by identity; omitted
            // patches have no replacement and must not shift other mappings.
            const byFit = new Map(qualified.map(record => [record[0], record]));
            selectedRecords.forEach(record => {
                const replacement = byFit.get(record[0]);
                if (replacement) prepared.set(record, replacement);
            });
            for (const record of failed) replaced.add(record);
            for (const record of selected) retained.add(record);
            // Stable input order, with each original included at most once.
            candidates = [...records.filter(record => !replaced.has(record)),
                ...unmerged.filter(record => retained.has(record) && prepared.has(record)).map(record => prepared.get(record)!)];
        }
    }
}
