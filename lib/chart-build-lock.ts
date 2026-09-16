import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const LEGACY_WRITE_GRACE_MS = 60_000;

export function processIsRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code !== 'ESRCH';
    }
}

function busy(basePath: string, pid?: number): Error {
    return new Error(`Chart build already in progress for ${path.basename(basePath)}` +
        (pid === undefined ? '' : ` (pid ${pid})`));
}

async function removeOwner(lockPath: string, marker: string): Promise<void> {
    try {
        await fs.unlink(path.join(lockPath, marker));
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    try {
        // A new owner always has a different marker and a nonempty directory.
        // A delayed release/reaper therefore cannot remove its lock.
        await fs.rmdir(lockPath);
    } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR'].includes(error.code)) throw error;
    }
}

async function recoverLegacyLock(lockPath: string, basePath: string): Promise<void> {
    let text: string;
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
        text = await fs.readFile(lockPath, 'utf8');
        stat = await fs.stat(lockPath);
    } catch (error) {
        if (['ENOENT', 'EISDIR'].includes(error.code)) return;
        throw error;
    }
    if (stat.isDirectory()) return;
    let owner: { pid?: number; token?: string } | undefined;
    try { owner = JSON.parse(text); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    const valid = owner && Number.isSafeInteger(owner.pid) && owner.pid > 0 &&
        typeof owner.token === 'string' && owner.token.length > 0;
    if (valid ? processIsRunning(owner.pid) : Date.now() - stat.mtimeMs < LEGACY_WRITE_GRACE_MS) {
        throw busy(basePath, valid ? owner.pid : undefined);
    }
    try {
        // Updated builders publish directories. unlink cannot remove one even
        // if another contender replaced this legacy file after we read it.
        await fs.unlink(lockPath);
    } catch (error) {
        if (!['ENOENT', 'EISDIR'].includes(error.code)) throw error;
    }
}

export async function acquireChartBuildLock(basePath: string): Promise<() => Promise<void>> {
    const lockPath = `${basePath}.build.lock`;
    const owner = { pid: process.pid, token: randomUUID() };
    const marker = `${owner.pid}-${owner.token}.json`;
    const pending = await fs.mkdtemp(`${lockPath}.pending-`);
    let acquired = false;
    try {
        await fs.writeFile(path.join(pending, marker), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
        for (let attempt = 0; attempt < 4; attempt += 1) {
            try {
                // Publish a fully initialized, nonempty directory atomically.
                // rename can replace an empty directory left by interrupted cleanup.
                await fs.rename(pending, lockPath);
                acquired = true;
                return () => removeOwner(lockPath, marker);
            } catch (error) {
                if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR'].includes(error.code)) throw error;
            }
            let entries: string[];
            try {
                entries = await fs.readdir(lockPath);
            } catch (error) {
                if (error.code === 'ENOENT') continue;
                if (error.code !== 'ENOTDIR') throw error;
                await recoverLegacyLock(lockPath, basePath);
                continue;
            }
            if (entries.length === 0) continue;
            const match = entries.length === 1 && entries[0].match(/^([1-9]\d*)-[a-f0-9-]{36}\.json$/);
            const pid = match ? Number(match[1]) : NaN;
            if (!Number.isSafeInteger(pid)) throw new Error(`Invalid chart build lock: ${lockPath}`);
            if (processIsRunning(pid)) throw busy(basePath, pid);
            await removeOwner(lockPath, entries[0]);
        }
        throw new Error(`Could not acquire chart build lock for ${path.basename(basePath)}`);
    } finally {
        if (!acquired) await fs.rm(pending, { recursive: true, force: true });
    }
}
