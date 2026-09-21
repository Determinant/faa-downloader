import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { downloadFile } from './http-download.ts';
import { extractZipEntry, listZipEntries, validateZipArchive } from './zip.ts';
import { sha256File } from './fs-utils.ts';

export type CifpSource = {
    group: 'CIFP'; url: string; filename: string; sha256: string;
    recordFile: { filename: 'FAACIFP18'; bytes: number; sha256: string };
};

/** Both online and offline builds require the same dated CIFP input. */
export async function acquireCifp(effectiveDate: string, cacheDirectory: string, sourceDirectory?: string) {
    const filename = `CIFP_${effectiveDate.slice(2).replaceAll('-', '')}.zip`;
    let raw: Buffer, sourceFile: string, url: string;
    if (sourceDirectory) {
        const directory = path.resolve(sourceDirectory);
        const extracted = path.join(directory, 'FAACIFP18');
        try {
            raw = await fs.readFile(extracted);
            sourceFile = extracted;
            url = pathToFileURL(extracted).href;
        } catch (error: unknown) {
            if (!isMissing(error)) throw error;
            sourceFile = path.join(directory, filename);
            try { await fs.access(sourceFile); }
            catch (error: unknown) {
                if (!isMissing(error)) throw error;
                throw new Error(`CIFP is required: provide FAACIFP18 or ${filename} in --source-dir (${directory})`);
            }
            url = pathToFileURL(sourceFile).href;
            raw = await readArchive(sourceFile, cacheDirectory);
        }
    } else {
        sourceFile = path.join(cacheDirectory, filename);
        url = `https://aeronav.faa.gov/Upload_313-d/cifp/${filename}`;
        await downloadFile(url, sourceFile, { userAgent: 'faa-regs-terminal-builder/1.0', validate: validateZipArchive });
        raw = await readArchive(sourceFile, cacheDirectory);
    }
    const sha256 = createHash('sha256').update(raw).digest('hex');
    const source: CifpSource = { group: 'CIFP', url, filename: path.basename(sourceFile),
        sha256: sourceFile.endsWith('.zip') ? await sha256File(sourceFile) : sha256,
        recordFile: { filename: 'FAACIFP18', bytes: raw.length, sha256 } };
    return { text: raw.toString('utf8'), source };
}

async function readArchive(archive: string, cacheDirectory: string): Promise<Buffer> {
    await validateZipArchive(archive);
    const entries = await listZipEntries(archive);
    if (entries.filter(entry => entry === 'FAACIFP18').length !== 1) {
        throw new Error(`${archive} must contain exactly one FAACIFP18 record file`);
    }
    await fs.mkdir(cacheDirectory, { recursive: true });
    const temporary = await fs.mkdtemp(path.join(cacheDirectory, '.cifp-'));
    try {
        const file = path.join(temporary, 'FAACIFP18');
        await extractZipEntry(archive, 'FAACIFP18', file);
        return await fs.readFile(file);
    } finally {
        await fs.rm(temporary, { recursive: true, force: true });
    }
}

function isMissing(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
