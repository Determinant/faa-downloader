import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DOMParser, type Element } from '@xmldom/xmldom';
import { buildFingerprint, matchesFile, readCachedJson, writeCachedJson } from './build-cache.ts';
import { sha256File } from './fs-utils.ts';
import type { ResolvedAsset } from './glide-model.ts';

export async function glideFetchText(url: string): Promise<string> {
    for (let attempt = 0; ; attempt++) {
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(60_000),
                headers: { 'user-agent': 'faa-downloader/build-glide', 'cache-control': 'no-cache' } });
            if (!response.ok) { await response.body?.cancel(); throw new Error(`Glide source HTTP ${response.status}: ${url}`); }
            const reader = response.body!.getReader(), chunks: Uint8Array[] = [];
            let bytes = 0;
            try {
                for (;;) {
                    const result = await reader.read();
                    if (result.done) break;
                    bytes += result.value.byteLength;
                    if (bytes > 16 * 1024 * 1024) throw new Error(`Glide source metadata exceeds 16 MiB: ${url}`);
                    chunks.push(result.value);
                }
            } finally { await reader.cancel(); }
            return Buffer.concat(chunks).toString('utf8');
        } catch (error) {
            if (attempt >= 2) throw error;
            await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
        }
    }
}

export function glideXml(text: string): Element {
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('Unexpected glide service XML declaration');
    const root = new DOMParser({ onError: (_level, message) => { throw new Error(`Invalid glide service XML: ${message}`); } })
        .parseFromString(text, 'application/xml').documentElement;
    if (/Exception/.test(root.localName)) throw new Error(`Glide service rejected request: ${root.textContent?.slice(0, 500)}`);
    return root;
}

export function xmlElements(root: Element, localName: string): Element[] {
    return Array.from(root.getElementsByTagNameNS('*', localName));
}

export type SourceDescription = Pick<ResolvedAsset, 'name' | 'date' | 'attribution' | 'url' | 'revision'>;

const verifiedSources = new AsyncLocalStorage<Map<string, Promise<boolean>>>();

/** Scope verification reuse to one build; changed files and explicit refreshes still get checked. */
export function withGlideSourceCache<T>(task: () => Promise<T>): Promise<T> {
    return verifiedSources.run(new Map(), task);
}

async function verifySource(file: string, asset: ResolvedAsset): Promise<boolean> {
    const verified = verifiedSources.getStore();
    if (!verified) return matchesFile(file, asset);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try { stat = await fs.stat(file); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    const key = JSON.stringify([file, asset.sha256, asset.bytes, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
    let check = verified.get(key);
    if (!check) {
        check = matchesFile(file, asset);
        verified.set(key, check);
    }
    return check;
}

export async function readGlideSource(cache: string, inputs: unknown, extension: 'tif' | 'gpkg' | 'geojson'): Promise<ResolvedAsset | undefined> {
    const key = buildFingerprint(inputs), file = path.join(cache, 'automatic', `${key}.${extension}`);
    const saved = await readCachedJson<ResolvedAsset>(`${file}.json`, `${file}.json.build.json`, key);
    return saved && await verifySource(file, saved) ? { ...saved, file } : undefined;
}

const pendingSources = new Map<string, { refresh: boolean; promise: Promise<ResolvedAsset> }>();

/** Share concurrent requests for the same snapshot, including derived native masks. */
export async function cachedGlideSource(cache: string, inputs: unknown, description: SourceDescription,
    extension: 'tif' | 'gpkg' | 'geojson', build: (file: string) => Promise<void>, refresh = false): Promise<ResolvedAsset> {
    const file = path.resolve(cache, 'automatic', `${buildFingerprint(inputs)}.${extension}`);
    const pending = pendingSources.get(file);
    if (pending) {
        const asset = await pending.promise;
        // An explicit refresh must not silently inherit an ordinary cache hit.
        return refresh && !pending.refresh ? cachedGlideSource(cache, inputs, description, extension, build, refresh) : asset;
    }
    const promise = prepareGlideSource(cache, inputs, description, extension, build, refresh);
    pendingSources.set(file, { refresh, promise });
    try { return await promise; }
    finally { pendingSources.delete(file); }
}

/** Immutable local snapshots, reused only after checking the saved bytes. */
async function prepareGlideSource(cache: string, inputs: unknown, description: SourceDescription,
    extension: 'tif' | 'gpkg' | 'geojson', build: (file: string) => Promise<void>, refresh: boolean): Promise<ResolvedAsset> {
    const key = buildFingerprint(inputs), directory = path.join(cache, 'automatic');
    const file = path.join(directory, `${key}.${extension}`), record = `${file}.json`, receipt = `${record}.build.json`;
    const saved = !refresh && await readGlideSource(cache, inputs, extension);
    if (saved) return saved;
    await fs.mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `.${key}-${randomUUID()}.${extension}`);
    try {
        await build(temporary);
        const asset = { ...description, file, bytes: (await fs.stat(temporary)).size, sha256: await sha256File(temporary) };
        if (!asset.bytes) throw new Error(`Empty automatic glide source: ${description.name}`);
        await fs.rename(temporary, file);
        await writeCachedJson(record, receipt, key, asset);
        return asset;
    } finally { await fs.rm(temporary, { force: true }); }
}
