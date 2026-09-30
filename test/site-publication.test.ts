import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateSplitPartSite } from '../lib/site-generator.ts';

const xslPath = new URL('../cfr-ecfr.xsl', import.meta.url).pathname;
const farXml = (text: string) => `<FAR><PART><EAR>Part 61</EAR><HD>Certification</HD><SECTION>` +
    `<SECTNO>§ 61.1</SECTNO><SUBJECT>Applicability</SUBJECT><P>${text}</P></SECTION></PART></FAR>`;

test('FAR part generations keep the previous shell usable until the new shell is committed', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faa-far-generation-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const htmlPath = path.join(root, 'index.html');
    const partsDir = path.join(root, 'index-parts');
    const build = (text: string) => generateSplitPartSite({
        farXml: farXml(text), htmlPath, xslPath, title: 14, chapter: 'I',
        sourceDescription: 'test', scopeDescription: 'test', partsDirArg: undefined
    });
    const linkedGeneration = (html: string) => {
        const match = html.match(/index-parts\/(generation-[a-f0-9-]{36})\/part-61\.html\?v=/);
        assert.ok(match, 'shell links to its part generation');
        return match[1];
    };

    await build('Original text.');
    const oldHtml = await fs.readFile(htmlPath, 'utf8');
    const oldGeneration = linkedGeneration(oldHtml);
    const oldPage = path.join(partsDir, oldGeneration, 'part-61.html');
    assert.match(await fs.readFile(oldPage, 'utf8'), /Original text/);
    assert.match(await fs.readFile(path.join(partsDir, 'part-61.html'), 'utf8'), /Original text/);

    const rename = fs.rename.bind(fs);
    t.mock.method(fs, 'rename', async (source: string, destination: string) => {
        if (destination === htmlPath) throw new Error('injected shell publish failure');
        return rename(source, destination);
    });
    try {
        await assert.rejects(build('Unpublished text.'), /injected shell publish failure/);
    } finally {
        t.mock.restoreAll();
    }
    assert.equal(await fs.readFile(htmlPath, 'utf8'), oldHtml);
    assert.match(await fs.readFile(oldPage, 'utf8'), /Original text/);
    assert.match(await fs.readFile(path.join(partsDir, 'part-61.html'), 'utf8'), /Original text/);

    await build('Updated text.');
    const newHtml = await fs.readFile(htmlPath, 'utf8');
    const newGeneration = linkedGeneration(newHtml);
    assert.notEqual(newGeneration, oldGeneration);
    const generations = (await fs.readdir(partsDir)).filter(name => name.startsWith('generation-'));
    assert.equal(generations.length, 3);
    assert.ok(generations.includes(oldGeneration));
    assert.ok(generations.includes(newGeneration));
    assert.match(await fs.readFile(oldPage, 'utf8'), /Original text/);
    const newPage = await fs.readFile(path.join(partsDir, newGeneration, 'part-61.html'), 'utf8');
    assert.match(newPage, /Updated text/);
    assert.match(await fs.readFile(path.join(partsDir, 'part-61.html'), 'utf8'), /Updated text/);
    assert.match(newPage, /\.\.\/\.\.\/vendor\/js-treeview\.min\.css/);
    assert.match(await fs.readFile(path.join(root, 'service-worker.js'), 'utf8'),
        new RegExp(`index-parts/${newGeneration}/part-61\\.html`));
});
