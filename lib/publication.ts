import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256File, writeFileAtomic } from './fs-utils.ts';

export type Artifact = { file: string; bytes: number; sha256: string; jsonSha256?: string };
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const jsonText = (value: unknown) => JSON.stringify(value);

export function artifactIdentity(name: string, bytes: Uint8Array): Artifact {
    if (!/^[\w.-]+\.[\w]+$/.test(name)) throw new Error(`Invalid artifact name: ${name}`);
    const sha256 = digest(bytes);
    return { file: name.replace(/(\.[^.]+)$/, `.${sha256}$1`), bytes: bytes.byteLength, sha256 };
}

/** JSON identity hashes UTF-8 JSON.stringify(parsed document), without a newline.
 * File identity hashes the exact delivered bytes, including the final newline. */
export function jsonArtifact(name: string, value: unknown): Artifact & { jsonSha256: string } {
    const text = jsonText(value);
    return { ...artifactIdentity(name, Buffer.from(`${text}\n`)), jsonSha256: digest(text) };
}

export async function stageArtifact(directory: string, name: string, bytes: Uint8Array): Promise<Artifact> {
    const artifact = artifactIdentity(name, bytes);
    await fs.writeFile(path.join(directory, artifact.file), bytes);
    return artifact;
}

export async function stageJson(directory: string, name: string, value: unknown): Promise<Artifact & { jsonSha256: string }> {
    const artifact = jsonArtifact(name, value);
    await fs.writeFile(path.join(directory, artifact.file), `${jsonText(value)}\n`);
    return artifact;
}

/** Immutable files become visible first. Replacing the manifest is the sole
 * commit point; interruption leaves a complete previous or next generation.
 * Old generations are retained until the containing edition is pruned. */
export async function publishGeneration(staging: string, target: string, manifest: unknown): Promise<void> {
    await fs.mkdir(target, { recursive: true });
    for (const name of await fs.readdir(staging)) {
        const hash = name.match(/\.([a-f0-9]{64})\.[^.]+$/)?.[1];
        if (!hash) throw new Error(`Publication requires an immutable artifact: ${name}`);
        const source = path.join(staging, name), destination = path.join(target, name);
        if (await sha256File(source) !== hash) throw new Error(`Artifact changed before publication: ${name}`);
        try { await fs.link(source, destination); }
        catch (error: any) {
            if (error.code !== 'EEXIST') throw error;
            if (await sha256File(destination) !== hash) throw new Error(`Published artifact is corrupt: ${name}`);
        }
    }
    await writeFileAtomic(path.join(target, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
}
