import { tileBounds } from './chart-package-grid.ts';
import { validateRegions } from './offline-regions.ts';
import { artifact, contains, DELIVERY_LIMITS as L, digest, integer, object, validBounds,
    type Archive, type Artifact, type DeliveryManifest, type Page } from './glide-delivery.ts';
import { validateBlock } from './glide-package-archive.ts';

export function validDeliveryArtifact(value: unknown, folders: string[]): boolean {
    return artifact(value) && object(value) && folders.some(folder =>
        value.file === `${folder}/${value.sha256}.${folder === 'detail' ? 'gld' : folder === 'overview' ? 'glo' : 'json'}`);
}
export function validatePage(value: unknown): asserts value is Page {
    if (!object(value) || !validDeliveryArtifact(value, ['indexes']) || value.bytes > L.pageBytes || !validBounds(value.bounds) ||
        !integer((value as Page).entries, 1, L.pageEntries) || !['detail', 'overview'].includes((value as Page).kind)) throw new Error('Invalid glide index reference');
}
export function validateArchive(value: unknown): asserts value is Archive {
    if (!object(value) || !['detail', 'overview'].includes(value.kind) || !validDeliveryArtifact(value, [value.kind]) ||
        value.bytes > L.archiveBytes || !validBounds((value as Archive).bounds) || !Array.isArray((value as Archive).blocks) ||
        !(value as Archive).blocks.length || (value as Archive).blocks.length > L.pageEntries) throw new Error('Invalid glide archive reference');
    const archive = value as Archive, keys = new Set<string>();
    let end = 0;
    for (const [i, block] of archive.blocks.entries()) {
        validateBlock(block);
        if (block.kind !== archive.kind || !contains(archive.bounds, block.bounds) || keys.has(block.key) ||
            !integer(block.offset, 17, archive.bytes - 1) || (i === 0 ? block.offset > L.directoryBytes + 16 : block.offset !== end)) throw new Error('Invalid indexed glide block');
        if (block.kind === 'overview') {
            const expected = tileBounds({ z: block.tile[0], x: block.tile[1], y: block.tile[2] });
            if (expected.some((v, i) => Math.abs(v - block.bounds[i]) > 1e-9)) throw new Error('Overview coordinates disagree with tile address');
        }
        keys.add(block.key); end = block.offset + block.bytes;
    }
    if (end !== archive.bytes) throw new Error('Archive directory omits or exceeds payload bytes');
}
export function validateIndex(value: unknown, page?: Page): asserts value is { schemaVersion: 1; kind: 'detail' | 'overview'; archives: Archive[] } {
    if (!object(value) || value.schemaVersion !== 1 || !['detail', 'overview'].includes(value.kind) ||
        !Array.isArray(value.archives) || !value.archives.length || value.archives.length > L.pageEntries ||
        page && (value.kind !== page.kind || value.archives.length !== page.entries)) throw new Error('Invalid glide index');
    const files = new Set<string>();
    for (const archive of value.archives) {
        validateArchive(archive);
        if (archive.kind !== value.kind || files.has(archive.file) || page && !contains(page.bounds, archive.bounds)) throw new Error('Glide index identity/bounds mismatch');
        files.add(archive.file);
    }
}
export function validateDependencyPage(value: unknown): asserts value is { schemaVersion: 1; files: Artifact[] } {
    if (!object(value) || value.schemaVersion !== 1 || !Array.isArray(value.files) || !value.files.length || value.files.length > L.pageEntries) throw new Error('Invalid glide dependency page');
    const files = new Set<string>();
    for (const entry of value.files) {
        if (!validDeliveryArtifact(entry, ['detail', 'overview', 'indexes', 'coverage', 'provenance']) || files.has(entry.file)) throw new Error('Invalid/duplicate glide region dependency');
        files.add(entry.file);
    }
}
export function validateRegionInventory(value: unknown, dependencies?: Artifact[]): void {
    if (!object(value) || value.schemaVersion !== 1 || !digest(value.definitionSha256) || !digest(value.sourceSha256) ||
        !['available', 'partial', 'unavailable'].includes(value.coverage) || !Array.isArray(value.indexes) || !Array.isArray(value.files)) throw new Error('Invalid glide region inventory');
    validateRegions([value as any]);
    if (value.indexes.length > 10_000 || value.files.length > L.pageEntries || value.filePages !== undefined &&
        (!Array.isArray(value.filePages) || value.filePages.length > 10_000 || value.files.length ||
            value.filePages.some(page => !validDeliveryArtifact(page, ['dependencies']) || page.bytes > L.pageBytes))) throw new Error('Invalid glide region dependency pages');
    const files = new Map<string, Artifact>();
    for (const entry of dependencies ?? value.files) {
        if (!validDeliveryArtifact(entry, ['detail', 'overview', 'indexes', 'coverage', 'provenance']) || files.has(entry.file)) throw new Error('Invalid/duplicate glide region dependency');
        files.set(entry.file, entry);
    }
    for (const page of value.indexes) {
        validatePage(page);
        const saved = files.get(page.file);
        if ((!value.filePages || dependencies) && (saved?.sha256 !== page.sha256 || saved.bytes !== page.bytes)) throw new Error('Region omits a required index');
    }
}
export function validateDeliveryManifest(value: unknown): asserts value is DeliveryManifest {
    if (!object(value) || value.product !== 'glide-packages' || value.schemaVersion !== 1 ||
        !digest(value.inputSha256) || !digest(value.packagingSha256) || !digest(value.detailDigest) ||
        !integer(value.totalBytes, 1, L.releaseBytes - 1) || !integer(value.records, 0, 1_000_000_000) ||
        typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt)) ||
        !object(value.source) || ![8, 9].includes(value.source.schemaVersion) || !integer(value.source.builderVersion, 1, 100_000) ||
        !digest(value.source.inputSha256) || !object(value.source.rules) || value.source.status !== 'experimental-candidates' ||
        value.source.geometryMeaning !== 'generalized-candidate-area' ||
        !validDeliveryArtifact(value.provenance, ['provenance']) || !validDeliveryArtifact(value.coverage, ['coverage']) ||
        !Array.isArray(value.indexes) || value.indexes.length > 10_000 || !Array.isArray(value.regions) || value.regions.length > 10_000 ||
        !object(value.overview) || value.overview.projection !== 'EPSG:3857' || value.overview.tileSize !== 256 ||
        value.overview.samplesPerAxis !== 4 || value.overview.minZoom !== 0 || ![10, 11].includes(value.overview.maxZoom) ||
        value.overview.encoding !== 'uint8-preferred-best-effort-prepared' || value.overview.densityMeaning !== 'sampled-ground-area-fraction' ||
        value.overview.version !== 1 || !object(value.limits) || Object.entries(L).some(([key, n]) => value.limits[key] !== n)) throw new Error('Invalid glide delivery manifest');
    const pages = new Set<string>(), ids = new Set<string>();
    for (const page of value.indexes) { validatePage(page); if (pages.has(page.file)) throw new Error('Duplicate glide index'); pages.add(page.file); }
    for (const region of value.regions) {
        if (!object(region) || !validDeliveryArtifact(region, ['regions']) || region.bytes > L.pageBytes || typeof (region as any).id !== 'string' || ids.has((region as any).id) ||
            !integer((region as any).downloadBytes, region.bytes, L.releaseBytes - 1) || !['available', 'partial', 'unavailable'].includes((region as any).coverage)) throw new Error('Invalid glide region reference');
        validateRegions([{ id: (region as any).id, title: (region as any).id, bounds: (region as any).bounds }]); ids.add((region as any).id);
    }
}
