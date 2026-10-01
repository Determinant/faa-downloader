import fs from 'node:fs/promises';
import path from 'node:path';
import { acquireChartBuildLock } from './chart-build-lock.ts';
import { chartMbtilesPath, legacyChartCycleDirectory } from './chart-paths.ts';
import { fileExists, hasErrorCode, sha256File, writeFileAtomic } from './fs-utils.ts';
import { isRecord, readJson } from './build-cache.ts';

type FileIdentity = {
    byteLength: number;
    sha256: string;
};

export type ChartBuildReceipt = {
    schemaVersion: 1;
    tilerVersion: number;
    configurationSha256: string;
    source: FileIdentity;
    output: FileIdentity;
};

export type ChartBuildConfiguration = Pick<ChartBuildReceipt, 'tilerVersion' | 'configurationSha256'>;

export function buildReceiptPath(mbtilesPath: string): string {
    return `${mbtilesPath}.build.json`;
}

function legacyTemporaryChartPaths(basePath: string): string[] {
    const nextMbtilesPath = `${basePath}.next.mbtiles`;
    const partialTilesPath = `${basePath}.next.partial_tiles.db`;
    return [
        `${basePath}-rgb.vrt`,
        `${basePath}-alpha.vrt`,
        nextMbtilesPath,
        `${nextMbtilesPath}-journal`,
        `${nextMbtilesPath}-shm`,
        `${nextMbtilesPath}-wal`,
        partialTilesPath,
        `${partialTilesPath}-journal`,
        `${partialTilesPath}-shm`,
        `${partialTilesPath}-wal`
    ];
}

async function removeStaleChartWork(basePath: string): Promise<void> {
    const directory = path.dirname(basePath);
    const prefix = `${path.basename(basePath)}.work-`;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    await Promise.all(
        entries
            .filter(entry => entry.isDirectory() && entry.name.startsWith(prefix))
            .map(entry => fs.rm(path.join(directory, entry.name), {
                recursive: true,
                force: true
            }))
    );
    await Promise.all(
        legacyTemporaryChartPaths(basePath).map(filePath => fs.rm(filePath, { force: true }))
    );
}

export async function withChartOutput<T>(
    tifPath: string,
    action: (mbtilesPath: string) => Promise<T>
): Promise<T> {
    const sourceBasePath = tifPath.replace(/\.tif$/i, '');
    const mbtilesPath = chartMbtilesPath(tifPath);
    // Keep the lock keyed to the source so old and new layout builds cannot race.
    const releaseLock = await acquireChartBuildLock(sourceBasePath);
    try {
        await fs.mkdir(path.dirname(mbtilesPath), { recursive: true });
        await removeStaleChartWork(sourceBasePath);
        await removeStaleChartWork(mbtilesPath.replace(/\.mbtiles$/i, ''));
        const moves: Array<[string, string]> = [];
        const legacyCycle = legacyChartCycleDirectory(path.dirname(tifPath));
        const oldPaths = [
            `${sourceBasePath}.mbtiles`,
            path.join(path.dirname(tifPath), 'mbtiles', path.basename(mbtilesPath)),
            ...(legacyCycle ? [
                path.join(legacyCycle, path.basename(mbtilesPath)),
                path.join(legacyCycle, 'mbtiles', path.basename(mbtilesPath))
            ] : [])
        ].filter(file => path.resolve(file) !== path.resolve(mbtilesPath));
        const destinations = new Set<string>();
        for (const legacyPath of oldPaths) {
            for (const suffix of ['', '.build.json']) {
                const source = `${legacyPath}${suffix}`;
                const destination = `${mbtilesPath}${suffix}`;
                if (!await fileExists(source)) continue;
                if (await fileExists(destination) || destinations.has(destination)) {
                    throw new Error(`Chart layout conflict: both ${source} and ${destination} exist`);
                }
                moves.push([source, destination]);
                destinations.add(destination);
            }
        }
        // Receipts contain content identities, not paths: relocating does not
        // invalidate a verified build or require rendering several GB again.
        // Check both destinations first; resume safely if an earlier move stopped
        // between the archive and its receipt. Never overwrite a destination.
        for (const [source, destination] of moves) await fs.rename(source, destination);
        return await action(mbtilesPath);
    } finally {
        await releaseLock();
    }
}

async function fileIdentity(filePath: string): Promise<FileIdentity> {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size === 0) {
        throw new Error(`Chart artifact is empty or is not a regular file: ${filePath}`);
    }
    return { byteLength: stat.size, sha256: await sha256File(filePath) };
}

function parseBuildReceipt(value: unknown): ChartBuildReceipt | null {
    if (!isRecord(value) || value.schemaVersion !== 1 ||
        !Number.isSafeInteger(value.tilerVersion) ||
        typeof value.configurationSha256 !== 'string' ||
        !isRecord(value.source) || !isRecord(value.output)) {
        return null;
    }
    const identities = [value.source, value.output];
    if (!identities.every(identity =>
        Number.isSafeInteger(identity.byteLength) && Number(identity.byteLength) > 0 &&
        typeof identity.sha256 === 'string' && /^[a-f0-9]{64}$/.test(identity.sha256)
    )) {
        return null;
    }
    return value as ChartBuildReceipt;
}

export async function currentBuildReceipt(
    tifPath: string,
    mbtilesPath: string,
    configuration: ChartBuildConfiguration
): Promise<ChartBuildReceipt | null> {
    const receipt = parseBuildReceipt(await readJson(buildReceiptPath(mbtilesPath)));
    if (!receipt || receipt.tilerVersion !== configuration.tilerVersion ||
        receipt.configurationSha256 !== configuration.configurationSha256) {
        return null;
    }
    let source: FileIdentity;
    let output: FileIdentity;
    try {
        [source, output] = await Promise.all([
            fileIdentity(tifPath),
            fileIdentity(mbtilesPath)
        ]);
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return null;
        throw error;
    }
    return source.byteLength === receipt.source.byteLength &&
        source.sha256 === receipt.source.sha256 &&
        output.byteLength === receipt.output.byteLength &&
        output.sha256 === receipt.output.sha256
        ? receipt
        : null;
}

export async function writeBuildReceipt(
    tifPath: string,
    mbtilesPath: string,
    configuration: ChartBuildConfiguration
): Promise<ChartBuildReceipt> {
    const [source, output] = await Promise.all([
        fileIdentity(tifPath),
        fileIdentity(mbtilesPath)
    ]);
    const receipt: ChartBuildReceipt = {
        schemaVersion: 1,
        tilerVersion: configuration.tilerVersion,
        configurationSha256: configuration.configurationSha256,
        source,
        output
    };
    await writeFileAtomic(
        buildReceiptPath(mbtilesPath),
        `${JSON.stringify(receipt, null, 2)}\n`
    );
    return receipt;
}
