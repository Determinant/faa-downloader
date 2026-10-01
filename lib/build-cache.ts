import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256File, writeFileAtomic } from './fs-utils.ts';

export type FileIdentity = { bytes: number; sha256: string };

export async function readJson<T = unknown>(file: string): Promise<T | undefined> {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) return;
        throw error;
    }
}

/** Missing or damaged cache entries are misses; filesystem failures remain errors. */
export async function matchesFile(file: string, identity: FileIdentity): Promise<boolean> {
    if (!identity || !Number.isSafeInteger(identity.bytes) || identity.bytes < 0 ||
        !/^[a-f0-9]{64}$/.test(identity.sha256)) return false;
    try {
        const stat = await fs.stat(file);
        return stat.isFile() && stat.size === identity.bytes && await sha256File(file) === identity.sha256;
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function matchesArtifacts(directory: string, artifacts: Array<FileIdentity & { file: string }>): Promise<boolean> {
    if (!Array.isArray(artifacts) || !artifacts.length) return false;
    for (const artifact of artifacts) {
        if (typeof artifact.file !== 'string' || path.basename(artifact.file) !== artifact.file ||
            !await matchesFile(path.join(directory, artifact.file), artifact)) return false;
    }
    return true;
}

export async function readVerifiedJson<T>(file: string, identity: FileIdentity): Promise<T | undefined> {
    if (!identity || !/^[a-f0-9]{64}$/.test(identity.sha256)) return;
    try {
        const contents = await fs.readFile(file);
        if (contents.length !== identity.bytes || createHash('sha256').update(contents).digest('hex') !== identity.sha256) return;
        return JSON.parse(contents.toString('utf8'));
    } catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) return;
        throw error;
    }
}

export function buildFingerprint(inputs: unknown): string {
    return checksum(JSON.stringify(inputs));
}

function checksum(contents: string): string {
    return createHash('sha256').update(contents).digest('hex');
}

// Receipts stay in the local build cache. Verify the published JSON itself before
// trusting its file identities or page indexes, including after an interrupted build.
export async function readCachedJson<T>(file: string, receiptFile: string, inputSha256: string): Promise<T | undefined> {
    try {
        const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
        if (receipt?.schemaVersion !== 1 || receipt.inputSha256 !== inputSha256) return;
        const contents = await fs.readFile(file, 'utf8');
        if (checksum(contents) !== receipt.outputSha256) return;
        return JSON.parse(contents);
    } catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) return;
        throw error;
    }
}

export async function writeCachedJson(file: string, receiptFile: string, inputSha256: string, value: unknown): Promise<void> {
    const contents = `${JSON.stringify(value)}\n`;
    await writeFileAtomic(file, contents);
    await writeFileAtomic(receiptFile, `${JSON.stringify({
        schemaVersion: 1, inputSha256, outputSha256: checksum(contents)
    })}\n`);
}

/** Record an already atomically published document without rewriting it. */
export async function recordCachedJson(file: string, receiptFile: string, inputSha256: string): Promise<void> {
    await writeFileAtomic(receiptFile, `${JSON.stringify({
        schemaVersion: 1, inputSha256, outputSha256: await sha256File(file)
    })}\n`);
}
