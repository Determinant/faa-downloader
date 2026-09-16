import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export async function sha256File(filePath: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    return hash.digest('hex');
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
        `.${path.basename(absolutePath)}.tmp-${process.pid}-${Date.now()}`
    );

    await fs.mkdir(parentDir, { recursive: true });
    try {
        // Node ignores the encoding for byte data; retain the original call
        // shape while accommodating its overloaded TypeScript signature.
        await fs.writeFile(temporaryPath, data as any, encoding);
        await fs.rename(temporaryPath, absolutePath);
    } finally {
        await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }
}

export async function replaceDirectoryAtomically(sourceDir, targetDir) {
    const backupDir = `${targetDir}.previous-${process.pid}-${Date.now()}`;
    let movedExisting = false;
    try {
        try {
            await fs.rename(targetDir, backupDir);
            movedExisting = true;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }

        await fs.rename(sourceDir, targetDir);
        if (movedExisting) await fs.rm(backupDir, { recursive: true, force: true });
    } catch (error) {
        if (movedExisting) {
            try {
                await fs.access(targetDir);
            } catch {
                await fs.rename(backupDir, targetDir).catch(() => {});
            }
        }
        throw error;
    }
}
