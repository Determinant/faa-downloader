import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    DEFAULT_DOWNLOAD_CONCURRENCY,
    DEFAULT_TILE_CONCURRENCY,
    mapWithConcurrency,
    parseConcurrency
} from '../lib/concurrency.ts';
import { downloadFile } from '../lib/http-download.ts';
import { validatePdfFile } from '../lib/pdf.ts';

const silentLogger = { log() {}, warn() {} };

test('dated downloads revalidate, replace corrections, and preserve good bytes on failed replacement', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'download-revalidate-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const destination = path.join(directory, 'edition.zip');
    let body = 'edition one', etag = '"one"', fail = false;
    const conditions: (string | null)[] = [];
    const options = { userAgent: 'test', revalidate: true, logger: silentLogger, maxAttempts: 1,
        validate: async (file: string) => { assert.notEqual(await fs.readFile(file, 'utf8'), 'invalid'); },
        fetch: (async (_url, init) => {
            const condition = new Headers(init?.headers).get('if-none-match');
            conditions.push(condition);
            if (fail) throw new Error('offline');
            return condition === etag ? new Response(null, { status: 304 })
                : new Response(body, { headers: { etag } });
        }) as typeof globalThis.fetch };
    await fs.writeFile(destination, 'legacy cache without validators');
    await downloadFile('https://example.test/edition.zip', destination, options);
    await downloadFile('https://example.test/edition.zip', destination, options);
    body = 'corrected edition'; etag = '"two"';
    await downloadFile('https://example.test/edition.zip', destination, options);
    assert.equal(await fs.readFile(destination, 'utf8'), body);
    assert.deepEqual(conditions, [null, '"one"', '"one"']);
    fail = true;
    await assert.rejects(downloadFile('https://example.test/edition.zip', destination, options), /offline/);
    fail = false; body = 'invalid'; etag = '"three"';
    await assert.rejects(downloadFile('https://example.test/edition.zip', destination, options));
    assert.equal(await fs.readFile(destination, 'utf8'), 'corrected edition');
    body = 'repaired edition';
    await downloadFile('https://example.test/edition.zip', destination, options);
    assert.equal(await fs.readFile(destination, 'utf8'), body);
    assert.equal(conditions.at(-1), '"two"', 'a rejected download cannot replace the cached validator');
});

test('revalidation uses Last-Modified or downloads anew when the server supplies no validator', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'download-modified-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const destination = path.join(directory, 'edition.pdf');
    const modified = 'Thu, 01 Oct 2026 09:01:00 GMT';
    let requests = 0;
    const options = { userAgent: 'test', revalidate: true, logger: silentLogger,
        fetch: (async (_url, init) => {
            const condition = new Headers(init?.headers).get('if-modified-since');
            requests++;
            if (requests === 2) {
                assert.equal(condition, modified);
                return new Response(null, { status: 304 });
            }
            return new Response(`revision ${requests}`, { headers: requests === 1 ? { 'last-modified': modified } : {} });
        }) as typeof globalThis.fetch };
    for (let i = 0; i < 4; i++) await downloadFile('https://example.test/edition.pdf', destination, options);
    assert.equal(await fs.readFile(destination, 'utf8'), 'revision 4');
});

test('a changed source restarts a versioned partial instead of mixing editions', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'download-versioned-partial-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const destination = path.join(directory, 'edition.zip');
    const url = 'https://example.test/edition.zip';
    let requests = 0;
    await downloadFile(url, destination, { userAgent: 'test', revalidate: true, logger: silentLogger,
        fetch: (async (_url, init) => {
            requests++;
            const headers = new Headers(init?.headers);
            if (requests === 1) return new Response('old', { headers: { etag: '"old"', 'content-length': '20' } });
            assert.equal(headers.get('range'), 'bytes=3-');
            assert.equal(headers.get('if-range'), '"old"');
            return new Response('complete new source', { headers: { etag: '"new"' } });
        }) as typeof globalThis.fetch });
    assert.equal(await fs.readFile(destination, 'utf8'), 'complete new source');
});

function minimalPdf(): Buffer {
    const header = '%PDF-1.7\n';
    return Buffer.from(
        `${header}xref\n0 1\n0000000000 65535 f \n` +
        `trailer\n<< /Size 1 >>\nstartxref\n${Buffer.byteLength(header)}\n%%EOF\n`,
        'ascii'
    );
}

test('parallel work respects its concurrency limit and preserves result order', async () => {
    let active = 0;
    let peak = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async value => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise(resolve => setImmediate(resolve));
        active -= 1;
        return value * 10;
    });

    assert.equal(peak, 2);
    assert.deepEqual(results, [10, 20, 30, 40, 50]);
});

test('download and tile concurrency default to four and accept only the supported range', () => {
    assert.equal(DEFAULT_DOWNLOAD_CONCURRENCY, 4);
    assert.equal(DEFAULT_TILE_CONCURRENCY, 4);
    assert.equal(parseConcurrency('4'), 4);
    for (const value of ['0', '1.5', '17', 'invalid']) {
        assert.throws(() => parseConcurrency(value), /integer from 1 to 16/);
    }
});

test('downloads resume a partial file with an HTTP range request', async () => {
    const contents = Buffer.from('%PDF-resumable-test-contents');
    let receivedRange = '';
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        receivedRange = String(new Headers(init?.headers).get('range') || '');
        const start = Number(receivedRange.match(/^bytes=(\d+)-$/)?.[1] || 0);
        return new Response(contents.subarray(start), {
            status: start > 0 ? 206 : 200,
            headers: {
                'content-length': String(contents.length - start),
                ...(start > 0 ? {
                    'content-range': `bytes ${start}-${contents.length - 1}/${contents.length}`
                } : {})
            }
        });
    }) as typeof globalThis.fetch;

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'download-resume-test-'));
    const destination = path.join(directory, 'chart.pdf');
    const partialSize = 9;
    try {
        await fs.writeFile(`${destination}.part`, contents.subarray(0, partialSize));
        assert.equal(await downloadFile('https://example.test/chart.pdf', destination, {
            userAgent: 'test',
            fetch,
            logger: silentLogger
        }), true);
        assert.equal(receivedRange, `bytes=${partialSize}-`);
        assert.deepEqual(await fs.readFile(destination), contents);
        await assert.rejects(fs.access(`${destination}.part`), /ENOENT/);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('an incomplete response is retried from the saved byte offset', async () => {
    const contents = Buffer.from('retry resumes this payload');
    const ranges: string[] = [];
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        const range = String(new Headers(init?.headers).get('range') || '');
        ranges.push(range);
        if (ranges.length === 1) {
            return new Response(contents.subarray(0, 6), {
                headers: { 'content-length': String(contents.length) }
            });
        }
        const start = Number(range.match(/^bytes=(\d+)-$/)?.[1]);
        return new Response(contents.subarray(start), {
            status: 206,
            headers: {
                'content-length': String(contents.length - start),
                'content-range': `bytes ${start}-${contents.length - 1}/${contents.length}`
            }
        });
    }) as typeof globalThis.fetch;

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'download-retry-test-'));
    const destination = path.join(directory, 'chart.pdf');
    try {
        await downloadFile('https://example.test/chart.pdf', destination, {
            userAgent: 'test',
            fetch,
            logger: silentLogger
        });
        assert.deepEqual(ranges, ['', 'bytes=6-']);
        assert.deepEqual(await fs.readFile(destination), contents);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('downloads restart cleanly when a server ignores a range request', async () => {
    const contents = Buffer.from('complete replacement');
    let receivedRange = '';
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        receivedRange = String(new Headers(init?.headers).get('range') || '');
        return new Response(contents, {
            headers: { 'content-length': String(contents.length) }
        });
    }) as typeof globalThis.fetch;

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'download-restart-test-'));
    const destination = path.join(directory, 'archive.zip');
    try {
        await fs.writeFile(`${destination}.part`, 'stale partial');
        await downloadFile('https://example.test/archive.zip', destination, {
            userAgent: 'test',
            fetch,
            logger: silentLogger
        });
        assert.equal(receivedRange, 'bytes=13-');
        assert.deepEqual(await fs.readFile(destination), contents);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('a complete partial is committed when the server reports the range is satisfied', async () => {
    const contents = Buffer.from('already complete');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'download-complete-test-'));
    const destination = path.join(directory, 'archive.zip');
    try {
        await fs.writeFile(`${destination}.part`, contents);
        await downloadFile('https://example.test/archive.zip', destination, {
            userAgent: 'test',
            fetch: (async () => new Response(null, {
                status: 416,
                headers: { 'content-range': `bytes */${contents.length}` }
            })) as typeof globalThis.fetch,
            logger: silentLogger
        });
        assert.deepEqual(await fs.readFile(destination), contents);
        await assert.rejects(fs.access(`${destination}.part`), /ENOENT/);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('optional downloads treat 404 as unavailable and discard stale partials', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'download-404-test-'));
    const destination = path.join(directory, 'missing.zip');
    try {
        await fs.writeFile(`${destination}.part`, 'stale partial');
        assert.equal(await downloadFile('https://example.test/missing.zip', destination, {
            userAgent: 'test',
            skipNotFound: true,
            maxAttempts: 1,
            fetch: (async () => new Response(null, { status: 404 })) as typeof globalThis.fetch,
            logger: silentLogger
        }), false);
        await assert.rejects(fs.access(`${destination}.part`), /ENOENT/);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('required downloads fail on 404 instead of publishing an incomplete set', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'download-required-404-test-'));
    const destination = path.join(directory, 'missing.zip');
    try {
        await assert.rejects(downloadFile('https://example.test/missing.zip', destination, {
            userAgent: 'test',
            fetch: (async () => new Response(null, { status: 404 })) as typeof globalThis.fetch,
            logger: silentLogger
        }), /404/);
        await assert.rejects(fs.access(destination), /ENOENT/);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('PDF validation requires a final trailer and a valid xref target', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-validation-test-'));
    const validPath = path.join(directory, 'valid.pdf');
    const truncatedPath = path.join(directory, 'truncated.pdf');
    const badXrefPath = path.join(directory, 'bad-xref.pdf');
    try {
        const valid = minimalPdf();
        await fs.writeFile(validPath, valid);
        await fs.writeFile(truncatedPath, valid.subarray(0, valid.indexOf('trailer')));
        await fs.writeFile(
            badXrefPath,
            Buffer.from(valid.toString('ascii').replace(/startxref\n\d+/, 'startxref\n6'))
        );
        await validatePdfFile(validPath);
        await assert.rejects(validatePdfFile(truncatedPath), /valid final trailer/);
        await assert.rejects(validatePdfFile(badXrefPath), /xref section/);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('a structurally truncated cached PDF is downloaded again', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-cache-test-'));
    const destination = path.join(directory, 'chart.pdf');
    const contents = minimalPdf();
    let fetches = 0;
    try {
        await fs.writeFile(destination, '%PDF-1.7\ntruncated');
        await downloadFile('https://example.test/chart.pdf', destination, {
            userAgent: 'test',
            validate: validatePdfFile,
            fetch: (async () => {
                fetches += 1;
                return new Response(new Uint8Array(contents), {
                    headers: { 'content-length': String(contents.length) }
                });
            }) as typeof globalThis.fetch,
            logger: silentLogger
        });
        assert.equal(fetches, 1);
        assert.deepEqual(await fs.readFile(destination), contents);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});
