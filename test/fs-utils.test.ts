import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../lib/fs-utils.ts';

test('concurrent atomic writes to one path use distinct temporary files', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-atomic-write-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    t.mock.method(Date, 'now', () => 12345);
    const file = path.join(root, 'manifest.json');
    const contents = Array.from({ length: 16 }, (_, index) => JSON.stringify({ index }));
    await Promise.all(contents.map(content => writeFileAtomic(file, content)));
    assert.ok(contents.includes(await fs.readFile(file, 'utf8')));
    assert.deepEqual(await fs.readdir(root), ['manifest.json']);
});
