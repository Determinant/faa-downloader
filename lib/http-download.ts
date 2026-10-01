import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256File, writeFileAtomic } from './fs-utils.ts';
import { InvalidDownloadError } from './download-validation.ts';

const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_PROGRESS_INTERVAL_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;

type Logger = Pick<Console, 'log' | 'warn'>;

export type DownloadOptions = {
    userAgent: string;
    /** Dated FAA URLs can be corrected without changing their filename. */
    revalidate?: boolean;
    /** Keep validators outside published directories when their cleanup is strict. */
    metadataFile?: string;
    validate?: (filePath: string, destination: string) => Promise<void>;
    /** Pure validators can reuse a previous successful check of the exact bytes. */
    validationKey?: string;
    skipNotFound?: boolean;
    idleTimeoutMs?: number;
    progressIntervalMs?: number;
    maxAttempts?: number;
    fetch?: typeof globalThis.fetch;
    logger?: Logger;
};

type ContentRange = {
    start: number;
    total?: number;
};

type TransferOptions = {
    userAgent: string;
    skipNotFound: boolean;
    idleTimeoutMs: number;
    progressIntervalMs: number;
    fetch: typeof globalThis.fetch;
    logger: Logger;
    revalidate: boolean;
    cached?: DownloadIdentity;
};

type DownloadIdentity = { url: string; etag?: string; lastModified?: string; size?: number; mtimeMs?: number;
    sha256?: string; validationKey?: string };
export type DownloadResult = { available: false } | { available: true; changed: boolean; sha256: string };
type TransferResult = { available: boolean; bytes: number; unchanged?: boolean; identity?: DownloadIdentity };

async function readIdentity(file: string, url: string): Promise<DownloadIdentity | undefined> {
    try {
        const value = JSON.parse(await fs.readFile(file, 'utf8'));
        if (value?.url === url) return value;
    } catch (error) {
        if (!hasErrorCode(error, 'ENOENT') && !(error instanceof SyntaxError)) throw error;
    }
}

function responseIdentity(url: string, response: Response): DownloadIdentity {
    return { url, etag: response.headers.get('etag') ?? undefined,
        lastModified: response.headers.get('last-modified') ?? undefined };
}

function rangeValidator(identity?: DownloadIdentity): string | undefined {
    return identity?.etag && !identity.etag.startsWith('W/') ? identity.etag : identity?.lastModified;
}

class RetryableDownloadError extends Error {}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function hasErrorCode(error: unknown, code: string): boolean {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === code;
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    const units = ['KiB', 'MiB', 'GiB'];
    let value = bytes;
    let unit = units[0];
    for (const candidate of units) {
        value /= 1024;
        unit = candidate;
        if (value < 1024 || candidate === units.at(-1)) break;
    }
    return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${unit}`;
}

function responseLength(response: Response): number | undefined {
    const raw = response.headers.get('content-length');
    if (!raw || !/^\d+$/.test(raw)) return undefined;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : undefined;
}

function parseContentRange(response: Response): ContentRange | undefined {
    const match = response.headers.get('content-range')
        ?.match(/^bytes (\d+)-\d+\/(\d+|\*)$/i);
    if (!match) return undefined;
    return {
        start: Number(match[1]),
        total: match[2] === '*' ? undefined : Number(match[2])
    };
}

function unsatisfiedRangeSize(response: Response): number | undefined {
    const match = response.headers.get('content-range')?.match(/^bytes \*\/(\d+)$/i);
    return match ? Number(match[1]) : undefined;
}

async function fileSize(filePath: string): Promise<number> {
    try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) throw new Error(`Download partial is not a file: ${filePath}`);
        return stat.size;
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return 0;
        throw error;
    }
}

function createWatchdog(controller: AbortController, timeoutMs: number): {
    reset: () => void;
    stop: () => void;
} {
    let timer: NodeJS.Timeout | undefined;
    const reset = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            controller.abort(new Error(
                `Download received no network data for ${timeoutMs / 1000} seconds`
            ));
        }, timeoutMs);
        timer.unref();
    };
    return { reset, stop: () => clearTimeout(timer) };
}

async function writeResponse(
    response: Response,
    partialPath: string,
    offset: number,
    expectedTotal: number | undefined,
    progressIntervalMs: number,
    logger: Logger,
    resetWatchdog: () => void
): Promise<number> {
    if (!response.body) throw new RetryableDownloadError('Download response has no body');

    const handle = await fs.open(partialPath, offset > 0 ? 'a' : 'w');
    const reader = response.body.getReader();
    const startedAt = Date.now();
    let received = offset;
    let lastProgressAt = startedAt;
    let complete = false;
    try {
        while (true) {
            let result: ReadableStreamReadResult<Uint8Array>;
            try {
                result = await reader.read();
            } catch (error) {
                throw new RetryableDownloadError(errorMessage(error), { cause: error });
            }
            if (result.done) {
                complete = true;
                break;
            }
            resetWatchdog();
            const chunk = Buffer.from(result.value);
            let written = 0;
            while (written < chunk.length) {
                const write = await handle.write(chunk, written, chunk.length - written, null);
                if (write.bytesWritten === 0) throw new Error(`Could not write ${partialPath}`);
                written += write.bytesWritten;
            }
            received += chunk.length;

            const now = Date.now();
            if (now - lastProgressAt >= progressIntervalMs) {
                const elapsedSeconds = Math.max((now - startedAt) / 1000, 0.001);
                const rate = (received - offset) / elapsedSeconds;
                logger.log(
                    `  ${path.basename(partialPath, '.part')}: ${formatBytes(received)}`
                    + `${expectedTotal === undefined ? '' : ` / ${formatBytes(expectedTotal)}`}`
                    + ` (${formatBytes(rate)}/s)`
                );
                lastProgressAt = now;
            }
        }
    } finally {
        if (!complete) await reader.cancel().catch(() => {});
        reader.releaseLock();
        await handle.close();
    }
    return received;
}

async function transferOnce(
    url: string,
    destination: string,
    options: TransferOptions
): Promise<TransferResult> {
    const partialPath = `${destination}.part`;
    let offset = await fileSize(partialPath);
    const partial = options.revalidate ? await readIdentity(`${partialPath}.http.json`, url) : undefined;
    // Never splice a correction onto an unversioned or obsolete partial download.
    if (options.revalidate && offset > 0 && !rangeValidator(partial)) {
        await fs.rm(partialPath, { force: true });
        offset = 0;
    }
    const cached = offset === 0 ? options.cached : undefined;
    const controller = new AbortController();
    const watchdog = createWatchdog(controller, options.idleTimeoutMs);
    watchdog.reset();

    options.logger.log(`${offset > 0 ? 'resuming' : cached ? 'checking' : 'downloading'} "${url}"`
        + `${offset > 0 ? ` from ${formatBytes(offset)}` : ''}`);

    try {
        let response: Response;
        try {
            response = await options.fetch(url, {
                signal: controller.signal,
                headers: {
                    'user-agent': options.userAgent,
                    'accept-encoding': 'identity',
                    ...(offset > 0 ? { range: `bytes=${offset}-`,
                        ...(rangeValidator(partial) ? { 'if-range': rangeValidator(partial)! } : {}) } : {}),
                    ...(cached?.etag ? { 'if-none-match': cached.etag }
                        : cached?.lastModified ? { 'if-modified-since': cached.lastModified } : {})
                }
            });
        } catch (error) {
            throw new RetryableDownloadError(
                `Download failed for ${url}: ${errorMessage(error)}`,
                { cause: error }
            );
        }
        watchdog.reset();

        const discardResponse = () => response.body?.cancel().catch(() => {});
        if (response.status === 304 && cached) {
            await discardResponse();
            return { available: true, bytes: cached.size!, unchanged: true };
        }
        // FAA's CDN can ignore If-None-Match and send 200 for identical bytes.
        // A matching strong ETag identifies the complete representation; require
        // its full length too, and cancel before consuming the redundant body. Weak
        // tags and Last-Modified alone cannot prove byte identity on a 200.
        const complete = options.cached;
        const completeLength = response.status === 200 ? responseLength(response)
            : response.status === 206 ? parseContentRange(response)?.total : undefined;
        if (complete?.etag?.startsWith('"') &&
            response.headers.get('etag') === complete.etag && complete.size !== undefined &&
            completeLength === complete.size) {
            await discardResponse();
            return { available: true, bytes: complete.size, unchanged: true };
        }
        if (response.status === 404 && options.skipNotFound) {
            await discardResponse();
            await fs.rm(partialPath, { force: true });
            options.logger.warn(`skipping unavailable download (404): ${url}`);
            return { available: false, bytes: 0 };
        }
        if (response.status === 416 && offset > 0) {
            await discardResponse();
            if (unsatisfiedRangeSize(response) === offset && (!options.revalidate ||
                rangeValidator(responseIdentity(url, response)) === rangeValidator(partial))) {
                return { available: true, bytes: offset, identity: partial };
            }
            await fs.rm(partialPath, { force: true });
            throw new RetryableDownloadError(`Saved partial is not valid for ${url}`);
        }
        if (!response.ok) {
            await discardResponse();
            const error = new Error(
                `Download request failed (${response.status} ${response.statusText}): ${url}`
            );
            if (response.status === 408 || response.status === 429 || response.status >= 500) {
                throw new RetryableDownloadError(error.message, { cause: error });
            }
            throw error;
        }

        const range = parseContentRange(response);
        if (response.status === 206 && range?.start !== offset) {
            await discardResponse();
            await fs.rm(partialPath, { force: true });
            throw new RetryableDownloadError(`Server returned an unexpected byte range for ${url}`);
        }
        if (offset > 0 && response.status !== 206) {
            options.logger.warn(`server did not honor resume for "${url}"; restarting the file`);
            offset = 0;
        }

        const identity = responseIdentity(url, response);
        if (options.revalidate) {
            if (offset > 0 && rangeValidator(identity) !== rangeValidator(partial)) {
                await discardResponse();
                await fs.rm(partialPath, { force: true });
                throw new RetryableDownloadError(`Source changed while resuming ${url}`);
            }
            // Truncate before replacing its identity, including across an interrupted restart.
            if (offset === 0) await fs.writeFile(partialPath, '');
            await writeFileAtomic(`${partialPath}.http.json`, JSON.stringify(identity));
        }

        const length = responseLength(response);
        const expectedTotal = range?.total
            ?? (length === undefined ? undefined : offset + length);
        const received = await writeResponse(
            response,
            partialPath,
            offset,
            expectedTotal,
            options.progressIntervalMs,
            options.logger,
            watchdog.reset
        );
        if (expectedTotal !== undefined && received !== expectedTotal) {
            throw new RetryableDownloadError(
                `Incomplete download for ${url}: received ${received} of ${expectedTotal} bytes`
            );
        }
        return { available: true, bytes: received, identity };
    } finally {
        watchdog.stop();
    }
}

export async function downloadFile(
    url: string,
    destination: string,
    options: DownloadOptions
): Promise<DownloadResult> {
    const partialPath = `${destination}.part`;
    const metadataFile = options.metadataFile ?? `${destination}.http.json`;
    const logger = options.logger ?? console;
    const validate = options.validate ?? (async () => {});
    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const progressIntervalMs = options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (!options.userAgent.trim()) throw new Error('Download userAgent must not be empty');
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0
        || !Number.isFinite(progressIntervalMs) || progressIntervalMs <= 0
        || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
        throw new Error('Download timeouts must be finite and positive; maxAttempts must be positive');
    }

    let existing: Awaited<ReturnType<typeof fs.stat>> | undefined;
    let cached: DownloadIdentity | undefined;
    let existingSha256: string | undefined;
    const identity = await readIdentity(metadataFile, url);
    try {
        existing = await fs.stat(destination);
    } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) throw error;
    }
    if (existing) {
        if (!existing.isFile()) throw new Error(`Download destination is not a regular file: ${destination}`);
        try {
            if (existing.size === 0) {
                throw new InvalidDownloadError('cached download is empty');
            }
            existingSha256 = await sha256File(destination);
            if (!options.validationKey || identity?.validationKey !== options.validationKey ||
                identity.sha256 !== existingSha256) await validate(destination, destination);
            if (!options.revalidate) {
                await fs.rm(partialPath, { force: true });
                logger.log(`file "${destination}" already exists`);
                await writeFileAtomic(metadataFile, JSON.stringify({ ...identity, url,
                    sha256: existingSha256, validationKey: options.validationKey, size: existing.size, mtimeMs: existing.mtimeMs }));
                return { available: true, changed: false, sha256: existingSha256 };
            }
        } catch (error) {
            if (!(error instanceof InvalidDownloadError)) throw error;
            logger.warn(`replacing invalid cached download "${destination}": ${errorMessage(error)}`);
            // Keep the previous bytes until a validated replacement can be renamed.
            existing = undefined;
        }
    }
    if (existing && options.revalidate) {
        if (identity?.size === existing.size && (identity.sha256 ? identity.sha256 === existingSha256
            : identity.mtimeMs === existing.mtimeMs)) cached = identity;
    }

    await fs.mkdir(path.dirname(destination), { recursive: true });
    let transfer: TransferResult | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            transfer = await transferOnce(url, destination, {
                userAgent: options.userAgent,
                idleTimeoutMs,
                progressIntervalMs,
                skipNotFound: options.skipNotFound ?? false,
                fetch: options.fetch ?? globalThis.fetch,
                logger,
                revalidate: options.revalidate ?? false,
                cached
            });
            break;
        } catch (error) {
            if (!(error instanceof RetryableDownloadError) || attempt === maxAttempts) throw error;
            logger.warn(
                `download attempt ${attempt} failed for "${url}": ${error.message}; retrying`
            );
            await new Promise(resolve => setTimeout(resolve, attempt * 500));
        }
    }

    if (!transfer?.available) return { available: false };
    if (transfer.unchanged) {
        await fs.rm(partialPath, { force: true });
        await fs.rm(`${partialPath}.http.json`, { force: true });
        logger.log(`source unchanged: "${destination}"`);
        await writeFileAtomic(metadataFile, JSON.stringify({ ...cached, url, sha256: existingSha256,
            validationKey: options.validationKey, size: existing.size, mtimeMs: existing.mtimeMs }));
        return { available: true, changed: false, sha256: existingSha256! };
    }
    let sha256: string;
    try {
        await validate(partialPath, destination);
        sha256 = await sha256File(partialPath);
        // Invalidate the old validator before committing new bytes; a crash must
        // never associate an old ETag with a replacement file.
        await fs.rm(metadataFile, { force: true });
        await fs.rename(partialPath, destination);
        const stat = await fs.stat(destination);
        await writeFileAtomic(metadataFile, JSON.stringify({ ...transfer.identity, url, sha256,
            validationKey: options.validationKey, size: stat.size, mtimeMs: stat.mtimeMs }));
        await fs.rm(`${partialPath}.http.json`, { force: true });
    } catch (error) {
        await fs.rm(partialPath, { force: true });
        throw error;
    }
    logger.log(`downloaded "${destination}" (${formatBytes(transfer.bytes)})`);
    return { available: true, changed: sha256 !== existingSha256, sha256 };
}
