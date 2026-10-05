import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { findGlideLandingGround } from '../lib/glide-analysis.ts';
import { glideSearchCases, searchSnapshot } from './fixtures/glide-search-inputs.ts';

// Captured from the implementation immediately before search reuse/halo pruning.
// Freeze complete qualifications, quality flags and every output cell label.
const expected = JSON.parse(await fs.readFile(new URL('./fixtures/glide-search-before.json', import.meta.url), 'utf8'));
for (const { name, grid, surface } of glideSearchCases()) {
    test(`search optimization preserves ${name}`, () => {
        assert.deepEqual(searchSnapshot(findGlideLandingGround(surface, grid)), expected[name]);
    });
}
