import fs from 'fs/promises';
import path from 'path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';

export async function sha256File(filePath: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    return hash.digest('hex');
}

/** Link a file into a new layout without replacing conflicting contents. */
export async function moveVerifiedFile(source: string, destination: string, label: string): Promise<void> {
    let linked = false;
    try { await fs.link(source, destination); linked = true; }
    catch (error: any) { if (error.code !== 'EEXIST') throw error; }
    if (!linked) {
        const [oldStat, newStat] = await Promise.all([fs.stat(source), fs.stat(destination)]);
        if (oldStat.size !== newStat.size || await sha256File(source) !== await sha256File(destination)) {
            throw new Error(`Conflicting ${label}: ${source} and ${destination}`);
        }
    }
    await fs.rm(source);
}

export function toPosixPath(value) {
    return String(value).split(path.sep).join('/');
}

export function relativeOutputReference(sourceFile, targetFile) {
    let reference = path.posix.relative(path.posix.dirname(sourceFile), targetFile);
    if (!reference) reference = path.posix.basename(targetFile);
    if (!reference.startsWith('.')) reference = `./${reference}`;
    return reference;
}

export function isStrictChildPath(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return Boolean(relative)
        && relative !== '..'
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative);
}

export async function writeFileAtomic(
    filePath: string,
    data: string | Uint8Array,
    encoding: BufferEncoding = 'utf8'
) {
    const absolutePath = path.resolve(filePath);
    const parentDir = path.dirname(absolutePath);
    const temporaryPath = path.join(
        parentDir,
        `.${path.basename(absolutePath)}.tmp-${process.pid}-${randomUUID()}`
    );

    await fs.mkdir(parentDir, { recursive: true });
    try {
        // Node ignores the encoding for byte data; retain the original call
        // shape while accommodating its overloaded TypeScript signature.
        await fs.writeFile(temporaryPath, data as any, { encoding, flag: 'wx' });
        await fs.rename(temporaryPath, absolutePath);
    } finally {
        await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }
}
