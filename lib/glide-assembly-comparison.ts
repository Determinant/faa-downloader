import { hash, inspectArea, jsonBytes, type SourceManifest } from './glide-delivery.ts';
import { readSourceShard } from './glide-package-input.ts';

/** Streaming, order-independent fingerprints retain multiplicity without retaining national geometry in RAM. */
export async function summarizeGlideAssembly(manifest: SourceManifest, directory: string) {
    const sums = { records: 0n, boundaries: 0n, holes: 0n, qualifications: 0n, featureIds: 0n };
    const mask = (1n << 256n) - 1n;
    const counts = { records: 0, rings: 0, holes: 0, vertices: 0, tiers: [0, 0] };
    const add = (key: keyof typeof sums, value: unknown) => { sums[key] = (sums[key] + BigInt('0x' + hash(jsonBytes(value)))) & mask; };
    for (const shard of manifest.shards) {
        const areas = await readSourceShard({ manifest, directory, manifestSha256: '', sourceFile: '' }, shard);
        for (const [index, area] of areas.entries()) {
            const info = inspectArea(area, manifest.schemaVersion);
            counts.records++; counts.rings += info.rings; counts.holes += info.rings - 1; counts.vertices += info.vertices;
            counts.tiers[area[0][7] - 1]++;
            add('records', area); add('boundaries', area[1]); add('qualifications', [area[0], area[2]]);
            for (const ring of area[1].slice(1)) add('holes', ring);
            add('featureIds', `${shard.sha256}:${index}`);
        }
    }
    return { counts, fingerprints: Object.fromEntries(Object.entries(sums).map(([key, sum]) => [key, sum.toString(16).padStart(64, '0')])) };
}
export function compareGlideAssemblies(baseline: Awaited<ReturnType<typeof summarizeGlideAssembly>>, assembled: Awaited<ReturnType<typeof summarizeGlideAssembly>>) {
    return { method: 'sum-sha256-multiset-v1', baseline, assembled,
        equal: Object.fromEntries(Object.keys(baseline.fingerprints).map(key => [key,
            baseline.fingerprints[key] === assembled.fingerprints[key]])),
        interpretation: 'Compares exact stored tuples, ring encodings, holes, qualifications/flags and source-shard IDs, independent of record order. Changed encodings may represent equivalent ground; no geometric-union equivalence is claimed.' };
}
