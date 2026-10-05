import { buildFingerprint, isRecord, readJson, readCachedJson, recordCachedJson } from './build-cache.ts';
import { GLIDE_RULES, GLIDE_VERSION, ALL_RASTER_ROLES, OPTIONAL_VECTOR_ROLES, VECTOR_ROLES, type ResolvedRegion } from './glide-model.ts';

/** Bump deliberately when changed analysis semantics make saved results invalid.
 * Performance-only edits do not invalidate checkpoints or change public v1. */
export const GLIDE_ANALYSIS_REVISION = 1;

export function glideAnalysisIdentity(): string {
    // Hash explicit metadata to retain the existing snapshot/receipt format.
    // No source files participate in this identity.
    return buildFingerprint({ version: GLIDE_VERSION, analysisRevision: GLIDE_ANALYSIS_REVISION });
}

/** Exact migration of the October 3 run, before early outline simplification was
 * restored. Qualification is compatible; reused chunks retain their outlines.
 * Pin the accepted policy so later rule/revision changes cannot adopt this run. */
export function glideAnalysisProfiles() {
    const current = { implementation: glideAnalysisIdentity(), rules: GLIDE_RULES };
    const { areaSimplificationM: _, ...previousRules } = GLIDE_RULES;
    return GLIDE_VERSION === 1 && GLIDE_ANALYSIS_REVISION === 1 &&
        buildFingerprint(GLIDE_RULES) === '5c75a8e1a70f4f52e0d65bc281f8551d9353b79ef24f512cf91836cecfcae868' ?
        [current, { implementation: 'cd4afcbc8f991234b98e8a43cb16343d21963f53818cfe9a6bb5e9f236c051e9', rules: previousRules }] : [current];
}

/** Only evidence dates used by cover reconciliation affect screening. All
 * source dates still belong in provenance. legacyDates permits an exact, verified
 * adoption of checkpoints written before irrelevant dates were omitted. */
export function glideSourceIdentity(region: ResolvedRegion, rastersOnly = false, legacyDates = false) {
    return { bounds: region.bounds, coverageBounds: region.coverageBounds,
        sources: Object.fromEntries([...ALL_RASTER_ROLES, ...OPTIONAL_VECTOR_ROLES, ...(rastersOnly ? [] : VECTOR_ROLES)].map(role =>
            [role, (region.sources[role] ?? []).map(({ sha256, bytes, date, obstacleSource, buildingSource, roadSource, groundSource }) =>
                ({ sha256, bytes, date: legacyDates || ['landcover', 'canopy', 'fineLandcover', 'ground'].includes(role) ? date : undefined,
                    obstacleSource, buildingSource, roadSource, groundSource }))])) };
}

/** Current key first, then only explicitly compatible historical formats. */
export function glideAnalysisFingerprints(region: ResolvedRegion, versions: readonly string[], rastersOnly = false): string[] {
    return [...new Set(glideAnalysisProfiles().flatMap(profile => [false, true].map(legacyDates =>
        buildFingerprint({ version: GLIDE_VERSION, ...profile, versions, ...glideSourceIdentity(region, rastersOnly, legacyDates) }))))];
}

/** Called under the build lock. Promote verified legacy receipts without
 * rewriting completed analysis. Missing, changed or corrupt inputs are misses. */
export async function readGlideAnalysis<T>(file: string, keys: string[]): Promise<T | undefined> {
    const receiptFile = `${file}.build.json`, receipt = await readJson(receiptFile);
    if (!isRecord(receipt) || typeof receipt.inputSha256 !== 'string' || !keys.includes(receipt.inputSha256)) return;
    const value = await readCachedJson<T>(file, receiptFile, receipt.inputSha256);
    if (value !== undefined && receipt.inputSha256 !== keys[0]) await recordCachedJson(file, receiptFile, keys[0]);
    return value;
}
