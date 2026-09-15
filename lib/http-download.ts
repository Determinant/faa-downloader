import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_PROGRESS_INTERVAL_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;

type Logger = Pick<Console, 'log' | 'warn'>;

export type DownloadOptions = {
    userAgent: string;
    validate?: (filePath: string, destination: string) => Promise<void>;
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
};

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
): Promise<{ available: boolean; bytes: number }> {
    const partialPath = `${destination}.part`;
    let offset = await fileSize(partialPath);
    const controller = new AbortController();
    const watchdog = createWatchdog(controller, options.idleTimeoutMs);
    watchdog.reset();

    options.logger.log(`${offset > 0 ? 'resuming' : 'downloading'} "${url}"`
        + `${offset > 0 ? ` from ${formatBytes(offset)}` : ''}`);

    try {
        let response: Response;
        try {
            response = await options.fetch(url, {
                signal: controller.signal,
                headers: {
                    'user-agent': options.userAgent,
                    'accept-encoding': 'identity',
                    ...(offset > 0 ? { range: `bytes=${offset}-` } : {})
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
        if (response.status === 404 && options.skipNotFound) {
            await discardResponse();
            await fs.rm(partialPath, { force: true });
            options.logger.warn(`skipping unavailable download (404): ${url}`);
            return { available: false, bytes: 0 };
        }
        if (response.status === 416 && offset > 0) {
            await discardResponse();
            if (unsatisfiedRangeSize(response) === offset) {
                return { available: true, bytes: offset };
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
        return { available: true, bytes: received };
    } finally {
        watchdog.stop();
    }
}

export async function downloadFile(
    url: string,
    destination: string,
    options: DownloadOptions
): Promise<boolean> {
    const partialPath = `${destination}.part`;
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
    try {
        existing = await fs.stat(destination);
    } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) throw error;
    }
    if (existing) {
        try {
            if (!existing.isFile() || existing.size === 0) {
                throw new Error('cached download is empty or is not a regular file');
            }
            await validate(destination, destination);
            await fs.rm(partialPath, { force: true });
            logger.log(`file "${destination}" already exists`);
            return true;
        } catch (error) {
            logger.warn(`replacing invalid cached download "${destination}": ${errorMessage(error)}`);
            await fs.rm(destination, { force: true });
        }
    }

    await fs.mkdir(path.dirname(destination), { recursive: true });
    let transfer: { available: boolean; bytes: number } | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            transfer = await transferOnce(url, destination, {
                userAgent: options.userAgent,
                idleTimeoutMs,
                progressIntervalMs,
                skipNotFound: options.skipNotFound ?? false,
                fetch: options.fetch ?? globalThis.fetch,
                logger
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

    if (!transfer?.available) return false;
    try {
        await validate(partialPath, destination);
        await fs.rename(partialPath, destination);
    } catch (error) {
        await fs.rm(partialPath, { force: true });
        throw error;
    }
    logger.log(`downloaded "${destination}" (${formatBytes(transfer.bytes)})`);
    return true;
}
