import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256File, writeFileAtomic } from './fs-utils.ts';
import type { ChartPackageManifest } from './chart-packager.ts';

// Caller holds the delivery directory's packages.build.lock, shared with the
// previous packager. Link all immutable files first, publish the pointer last,
// then remove the old links. An interrupted migration is safely repeatable.
export async function flattenChartPackages(output: string): Promise<void> {
    const legacy = path.join(output, 'packages');
    let entries: string[];
    try { entries = await fs.readdir(legacy); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const targetManifest = path.join(output, 'manifest.json');
    let json: string;
    try { json = await fs.readFile(path.join(legacy, 'manifest.json'), 'utf8'); }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // Resume cleanup after the flat index was committed and the nested index
        // removed. The flat index must still verify before any old links are removed.
        json = await fs.readFile(targetManifest, 'utf8');
    }
    const manifest: ChartPackageManifest = JSON.parse(json);
    assert.ok(manifest.schemaVersion === 2 && manifest.packagingVersion === 1 && Array.isArray(manifest.archives),
        'Invalid legacy package manifest');
    const files = entries.filter(file => file !== 'manifest.json');
    const packageName = /^(?:vfr-sectional|vfr-terminal|vfr-flyway|ifr-low)-z\d+-r\d+-\d+-\d+-([a-f0-9]{64})\.mbtiles$/;
    const sizes = new Map<string, number>();
    for (const file of files) {
        const match = packageName.exec(file);
        assert.ok(match, `Unexpected file in legacy packages: ${file}`);
        const source = path.join(legacy, file);
        assert.equal(await sha256File(source), match[1], `Corrupt package: ${file}`);
        sizes.set(file, (await fs.stat(source)).size);
    }
    for (const archive of manifest.archives) {
        assert.equal(archive.file, `${archive.id}-${archive.sha256}.mbtiles`);
        assert.match(archive.file, packageName);
        if (!sizes.has(archive.file)) {
            const target = path.join(output, archive.file);
            assert.equal(await sha256File(target), archive.sha256, `Missing or corrupt package: ${archive.file}`);
            sizes.set(archive.file, (await fs.stat(target)).size);
        }
        assert.equal(sizes.get(archive.file), archive.byteLength, `Invalid package length: ${archive.file}`);
    }
    try {
        assert.deepEqual(JSON.parse(await fs.readFile(targetManifest, 'utf8')), manifest,
            'Conflicting flat and nested package manifests');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const file of files) {
        const source = path.join(legacy, file);
        const target = path.join(output, file);
        try { await fs.link(source, target); }
        catch (error) {
            if (error.code !== 'EEXIST') throw error;
            assert.equal(await sha256File(target), await sha256File(source), `Conflicting package: ${file}`);
        }
    }
    await writeFileAtomic(targetManifest, json);
    // The complete old directory can remain after a crash; retries above accept
    // already-linked files. Remove the old manifest before its files so a partial
    // cleanup is not mistaken for a still-publishable nested feed.
    await fs.rm(path.join(legacy, 'manifest.json'), { force: true });
    for (const file of files) await fs.rm(path.join(legacy, file));
    await fs.rmdir(legacy);
}
