import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { publishGeneration, stageJson } from '../lib/publication.ts';

test('interrupted publication always leaves the old or new manifest and all its immutable files readable', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-publication-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    for (const step of ['artifact', 'before-commit', 'after-commit']) {
        const directory = path.join(root, step), staging = path.join(directory, 'staging'), live = path.join(directory, 'nav');
        await fs.mkdir(staging, { recursive: true });
        const old = await stageJson(staging, 'airports.geojson', { edition: 'old' });
        await publishGeneration(staging, live, old);
        await fs.rm(path.join(staging, old.file));
        const next = await stageJson(staging, 'airports.geojson', { edition: 'new' });
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
            import fs from 'node:fs/promises';
            import { publishGeneration } from ${JSON.stringify(new URL('../lib/publication.ts', import.meta.url).href)};
            const rename = fs.rename.bind(fs), link = fs.link.bind(fs);
            fs.link = async (...args) => { await link(...args); if (${JSON.stringify(step)} === 'artifact') process.exit(91); };
            fs.rename = async (...args) => {
                if (${JSON.stringify(step)} === 'before-commit') process.exit(91);
                await rename(...args);
                if (${JSON.stringify(step)} === 'after-commit') process.exit(91);
            };
            await publishGeneration(${JSON.stringify(staging)}, ${JSON.stringify(live)}, ${JSON.stringify(next)});
        `], { encoding: 'utf8' });
        assert.equal(child.status, 91, child.stderr);
        const manifest = JSON.parse(await fs.readFile(path.join(live, 'manifest.json'), 'utf8'));
        const expected = step === 'after-commit' ? 'new' : 'old';
        assert.equal(JSON.parse(await fs.readFile(path.join(live, manifest.file), 'utf8')).edition, expected);
        assert.equal(JSON.parse(await fs.readFile(path.join(live, old.file), 'utf8')).edition, 'old');
        await publishGeneration(staging, live, next);
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(live, 'manifest.json'), 'utf8')), next);
    }
});
