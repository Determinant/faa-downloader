import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { InvalidDownloadError } from './download-validation.ts';

const execFileAsync = promisify(execFile);
const MAX_COMMAND_OUTPUT = 16 * 1024 * 1024;

function commandFailure(command: string, args: string[], error: any): Error {
    const detail = String(error.stderr || error.stdout || error.message || error).trim();
    return new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`, { cause: error });
}

export function assertSafeZipEntry(entry: string): void {
    if (!entry || entry.includes('\0') || entry.includes('\r') || entry.includes('\n')) {
        throw new Error('ZIP entry must be a non-empty single-line path');
    }
    if (entry.includes('\\') || path.posix.isAbsolute(entry) || entry.startsWith('-')) {
        throw new Error(`Unsafe ZIP entry path: ${entry}`);
    }
    const segments = entry.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
        throw new Error(`Unsafe ZIP entry path: ${entry}`);
    }
    if (['*', '?', '[', ']'].some(character => entry.includes(character))) {
        throw new Error(`ZIP entry contains pattern characters: ${entry}`);
    }
}

export async function validateZipArchive(archivePath: string): Promise<void> {
    const args = ['-tq', path.resolve(archivePath)];
    try {
        await execFileAsync('unzip', args, { maxBuffer: MAX_COMMAND_OUTPUT });
    } catch (error: any) {
        // Numeric unzip status reports invalid bytes; spawn/I/O failures do not.
        if (typeof error.code === 'number' && [1, 2, 3, 9, 51].includes(error.code)) {
            throw new InvalidDownloadError(commandFailure('unzip', args, error).message, { cause: error });
        }
        throw commandFailure('unzip', args, error);
    }
}

export async function listZipEntries(archivePath: string): Promise<string[]> {
    const args = ['-Z1', path.resolve(archivePath)];
    try {
        const { stdout } = await execFileAsync('unzip', args, {
            encoding: 'utf8',
            maxBuffer: MAX_COMMAND_OUTPUT
        });
        return String(stdout).split(/\r?\n/).filter(Boolean);
    } catch (error: any) {
        throw commandFailure('unzip', args, error);
    }
}

export async function extractZipEntry(
    archivePath: string,
    archiveEntry: string,
    destination: string
): Promise<void> {
    assertSafeZipEntry(archiveEntry);
    const absoluteDestination = path.resolve(destination);
    await fs.mkdir(path.dirname(absoluteDestination), { recursive: true });
    const temporary = path.join(
        path.dirname(absoluteDestination),
        `.${path.basename(absoluteDestination)}.${process.pid}.${Date.now()}.tmp`
    );
    const args = ['-p', path.resolve(archivePath), archiveEntry];
    const child = spawn('unzip', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
        if (stderr.length < MAX_COMMAND_OUTPUT) stderr += chunk;
    });

    const processDone = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => {
            if (code === 0) {
                resolve();
            } else {
                const status = signal ? `signal ${signal}` : `exit code ${code}`;
                reject(new Error(
                    `unzip ${archiveEntry} failed with ${status}`
                    + `${stderr.trim() ? `: ${stderr.trim()}` : ''}`
                ));
            }
        });
    });
    const outputDone = pipeline(
        child.stdout,
        createWriteStream(temporary, { flags: 'wx' })
    );

    try {
        await Promise.all([outputDone, processDone]);
        const stat = await fs.stat(temporary);
        if (!stat.isFile() || stat.size === 0) {
            throw new Error(`ZIP entry is empty: ${archiveEntry}`);
        }
        await fs.rename(temporary, absoluteDestination);
    } catch (error) {
        child.kill();
        await Promise.allSettled([outputDone, processDone]);
        throw error;
    } finally {
        await fs.rm(temporary, { force: true });
    }
}
