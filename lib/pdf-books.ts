import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256File, toPosixPath } from './fs-utils.ts';
import { pdfBookFolder } from './pdf-layout.ts';
import { matchesFile } from './build-cache.ts';

type PdfBookSource = { cycle: string; name: string; file: string };

async function entries(directory: string) {
    try { return await fs.readdir(directory, { withFileTypes: true }); }
    catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
}

/** Include raw-only editions and catalog-only notice cycles. */
export async function pdfBookCycles(output: string, through: string): Promise<string[]> {
    const roots = ['sources', 'charts'].map(folder => path.resolve(output, folder));
    return [...new Set((await Promise.all(roots.map(entries))).flat()
        .filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name) && entry.name <= through)
        .map(entry => entry.name))].sort().reverse();
}

/** Newest editions first; downloaded sources take precedence over legacy books.
 * Hash-named publications are retained snapshots, never candidates for new builds.
 */
export async function pdfBookSources(output: string, through: string): Promise<PdfBookSource[]> {
    const roots = ['sources', 'charts'].map(folder => path.resolve(output, folder));
    const cycles = await pdfBookCycles(output, through);
    const sources: PdfBookSource[] = [];
    for (const cycle of cycles) {
        const found = new Set<string>();
        for (const root of roots) for (const folder of ['tpp', 'cs']) {
            const directory = path.join(root, cycle, folder);
            for (const entry of await entries(directory)) {
                if (!entry.isFile() || !/^(tpp|cs)-[a-z0-9]+\.pdf$/i.test(entry.name) ||
                    pdfBookFolder(entry.name) !== folder || found.has(entry.name.toLowerCase())) continue;
                found.add(entry.name.toLowerCase());
                sources.push({ cycle, name: entry.name, file: path.join(directory, entry.name) });
            }
        }
    }
    return sources;
}

/** Snapshot before indexing: source revalidation and failed catalog builds must
 * never change bytes at a URL already referenced by a published/saved catalog.
 */
export async function publishPdfBook(output: string, source: PdfBookSource, catalogDirectory: string) {
    const directory = path.resolve(output, 'charts', source.cycle, pdfBookFolder(source.name)!);
    await fs.mkdir(directory, { recursive: true });
    const sourceSha256 = await sha256File(source.file);
    const sourceBytes = (await fs.stat(source.file)).size;
    const published = path.join(directory, `${source.name.slice(0, -4)}.${sourceSha256}.pdf`);
    if (await matchesFile(published, { bytes: sourceBytes, sha256: sourceSha256 })) {
        return { filePath: published, url: toPosixPath(path.relative(catalogDirectory, published)),
            byteLength: sourceBytes, sha256: sourceSha256 };
    }
    const staging = await fs.mkdtemp(path.join(directory, '.pdf-'));
    const snapshot = path.join(staging, source.name);
    try {
        // Reflink when supported, otherwise copy. A hard link to the mutable
        // source would allow local edits to change an already published book.
        await fs.copyFile(source.file, snapshot, constants.COPYFILE_FICLONE);
        const sha256 = await sha256File(snapshot);
        const byteLength = (await fs.stat(snapshot)).size;
        const filePath = path.join(directory, `${source.name.slice(0, -4)}.${sha256}.pdf`);
        try { await fs.link(snapshot, filePath); }
        catch (error: any) {
            if (error.code !== 'EEXIST') throw error;
            if ((await fs.stat(filePath)).size !== byteLength || await sha256File(filePath) !== sha256) {
                throw new Error(`Published PDF identity mismatch: ${filePath}`);
            }
        }
        return { filePath, url: toPosixPath(path.relative(catalogDirectory, filePath)), byteLength, sha256 };
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
}
