import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { downloadFile } from './http-download.ts';
import { extractZipEntry, listZipEntries, validateZipArchive } from './zip.ts';
import { copyFileAtomic, sha256File, writeFileAtomic } from './fs-utils.ts';
import { matchesFile, readJson } from './build-cache.ts';

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
        await fs.mkdir(cacheDirectory, { recursive: true });
        const cached = path.join(cacheDirectory, path.basename(sourceFile));
        if (path.resolve(sourceFile) !== path.resolve(cached)) {
            const identity = { bytes: (await fs.stat(sourceFile)).size, sha256: await sha256File(sourceFile) };
            if (!await matchesFile(cached, identity)) await copyFileAtomic(sourceFile, cached);
        }
    } else {
        sourceFile = path.join(cacheDirectory, filename);
        url = `https://aeronav.faa.gov/Upload_313-d/cifp/${filename}`;
        await downloadFile(url, sourceFile, { userAgent: 'faa-regs-terminal-builder/1.0',
            validate: validateZipArchive, validationKey: 'zip-v1', revalidate: true });
        raw = await readArchive(sourceFile, cacheDirectory);
    }
    const sha256 = createHash('sha256').update(raw).digest('hex');
    if (sourceFile.endsWith('.zip')) {
        const cachedRaw = path.join(cacheDirectory, 'FAACIFP18');
        try {
            if (await sha256File(cachedRaw) !== sha256) throw new Error('Cached CIFP text conflicts with its ZIP');
            await fs.rm(cachedRaw);
        } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
    const source: CifpSource = { group: 'CIFP', url, filename: path.basename(sourceFile),
        sha256: sourceFile.endsWith('.zip') ? await sha256File(sourceFile) : sha256,
        recordFile: { filename: 'FAACIFP18', bytes: raw.length, sha256 } };
    return { text: raw.toString('utf8'), source };
}

async function readArchive(archive: string, cacheDirectory: string): Promise<Buffer> {
    const sourceSha256 = await sha256File(archive);
    const file = path.join(cacheDirectory, 'cifp-records.txt');
    const receiptFile = path.join(cacheDirectory, 'cifp-records.build.json');
    const cached = await readJson<{ version: number; sourceSha256: string; record: { bytes: number; sha256: string } }>(receiptFile);
    if (cached?.version === 1 && cached.sourceSha256 === sourceSha256 && await matchesFile(file, cached.record)) {
        return fs.readFile(file);
    }
    await validateZipArchive(archive);
    const entries = await listZipEntries(archive);
    if (entries.filter(entry => entry === 'FAACIFP18').length !== 1) {
        throw new Error(`${archive} must contain exactly one FAACIFP18 record file`);
    }
    await fs.mkdir(cacheDirectory, { recursive: true });
    await extractZipEntry(archive, 'FAACIFP18', file);
    const raw = await fs.readFile(file);
    await writeFileAtomic(receiptFile, JSON.stringify({ version: 1, sourceSha256,
        record: { bytes: raw.length, sha256: createHash('sha256').update(raw).digest('hex') } }));
    return raw;
}

function isMissing(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
