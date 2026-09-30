import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256File, toPosixPath } from './fs-utils.ts';

export function pdfBookFolder(filename: string): 'tpp' | 'cs' | undefined {
    if (/^tpp-[a-z0-9]+\.pdf$/i.test(filename)) return 'tpp';
    if (/^cs-[a-z0-9]+\.pdf$/i.test(filename)) return 'cs';
    return undefined;
}

export async function tppBookFiles(directory: string): Promise<string[]> {
    return (await fs.readdir(directory, { withFileTypes: true }))
        .filter(entry => entry.isFile() && pdfBookFolder(entry.name) === 'tpp')
        .map(entry => entry.name);
}

export async function linkLegacyPdfBooks(chartsRoot: string): Promise<string[]> {
    const originals: string[] = [];
    for (const cycle of await fs.readdir(chartsRoot, { withFileTypes: true })) {
        if (!cycle.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(cycle.name)) continue;
        const cycleDirectory = path.join(chartsRoot, cycle.name);
        for (const entry of await fs.readdir(cycleDirectory, { withFileTypes: true })) {
            if (!entry.isFile()) continue;
            const folder = pdfBookFolder(entry.name);
            if (!folder) continue;
            const source = path.join(cycleDirectory, entry.name);
            const destination = path.join(cycleDirectory, folder, entry.name);
            await fs.mkdir(path.dirname(destination), { recursive: true });
            try { await fs.link(source, destination); }
            catch (error: any) {
                if (error.code !== 'EEXIST') throw error;
                const [oldStat, newStat] = await Promise.all([fs.stat(source), fs.stat(destination)]);
                if (oldStat.size !== newStat.size || await sha256File(source) !== await sha256File(destination)) {
                    throw new Error(`Conflicting PDF book: ${source} and ${destination}`);
                }
            }
            originals.push(source);
        }
    }
    return originals;
}

export async function relocatedPdfVolumes<T extends { url: string; byteLength: number; sha256: string }>(
    catalogDirectory: string, volumes: T[]
): Promise<T[]> {
    return Promise.all(volumes.map(async volume => {
        if (path.isAbsolute(volume.url) || volume.url.includes('://')) throw new Error(`Invalid PDF book URL: ${volume.url}`);
        const oldPath = path.resolve(catalogDirectory, volume.url);
        const folder = pdfBookFolder(path.basename(oldPath));
        if (!folder) throw new Error(`Invalid PDF book URL: ${volume.url}`);
        const destination = path.basename(path.dirname(oldPath)) === folder
            ? oldPath : path.join(path.dirname(oldPath), folder, path.basename(oldPath));
        const stat = await fs.stat(destination);
        if (stat.size !== volume.byteLength || await sha256File(destination) !== volume.sha256) {
            throw new Error(`PDF book identity mismatch: ${destination}`);
        }
        return { ...volume, url: toPosixPath(path.relative(catalogDirectory, destination)) };
    }));
}
