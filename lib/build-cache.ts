import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { writeFileAtomic } from './fs-utils.ts';

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
