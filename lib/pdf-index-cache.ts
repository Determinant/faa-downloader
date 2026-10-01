import path from 'node:path';
import { buildFingerprint, readCachedJson, writeCachedJson } from './build-cache.ts';
import { sha256File } from './fs-utils.ts';

/** Each book is indexed independently of the catalogs and editions that use it. */
export async function cachedPdfIndex<T>(output: string, book: { file: string; sha256: string },
    kind: 'tpp' | 'cs', parserVersion: string | number, build: () => Promise<T>, force = false): Promise<T> {
    const fingerprint = buildFingerprint({ sha256: book.sha256, kind, parserVersion });
    const file = path.join(output, 'pdf-indexes', `${book.sha256}.${kind}.json`);
    const receipt = `${file}.build.json`;
    if (!force) {
        const cached = await readCachedJson<T>(file, receipt, fingerprint);
        if (cached !== undefined) return cached;
    }
    const index = await build();
    if (await sha256File(book.file) !== book.sha256) throw new Error(`PDF changed while indexing: ${book.file}`);
    await writeCachedJson(file, receipt, fingerprint, index);
    return index;
}
