import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { rootCertificates } from 'node:tls';
import { promisify } from 'node:util';
import test from 'node:test';
import { GdalPool, gdalCli } from '../lib/gdal.ts';

test('native HTTPS range reads honor CA settings and still reject untrusted certificates', { timeout: 30_000 }, async t => {
    const exec = promisify(execFile);
    try { await gdalCli('gdal_create', ['--version']); await exec('openssl', ['version']); }
    catch { t.skip('Requires GDAL and OpenSSL'); return; }
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'gdal-https-'));
    t.after(() => fs.rm(work, { recursive: true, force: true }));
    const key = path.join(work, 'key.pem'), cert = path.join(work, 'cert.pem');
    await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-keyout', key, '-out', cert]);
    const raster = path.join(work, 'input.tif');
    await gdalCli('gdal_create', ['-of', 'GTiff', '-outsize', '8', '8', '-burn', '42', raster]);
    const data = await fs.readFile(raster);
    const unrelated = path.join(work, 'unrelated-ca.pem');
    await fs.writeFile(unrelated, rootCertificates[0]);
    let ranges = 0;
    const server = https.createServer({ key: await fs.readFile(key), cert: await fs.readFile(cert) }, (req, res) => {
        if (req.url !== '/input.tif') { res.writeHead(404).end(); return; }
        const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
        const start = range ? Number(range[1]) : 0;
        const end = Math.min(data.length - 1, range?.[2] ? Number(range[2]) : data.length - 1);
        if (start > end) { res.writeHead(416).end(); return; }
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', 'image/tiff');
        res.setHeader('Content-Length', end - start + 1);
        if (range) { ranges++; res.setHeader('Content-Range', `bytes ${start}-${end}/${data.length}`); }
        res.writeHead(range ? 206 : 200);
        res.end(req.method === 'HEAD' ? undefined : data.subarray(start, end + 1));
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `/vsicurl/https://127.0.0.1:${address.port}/input.tif`;
    const keys = ['CURL_CA_BUNDLE', 'SSL_CERT_FILE', 'NIX_SSL_CERT_FILE', 'GDAL_BACKEND', 'NO_PROXY', 'no_proxy'];
    const saved = keys.map(key => process.env[key]);
    t.after(() => keys.forEach((key, i) => {
        if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i];
    }));
    process.env.GDAL_BACKEND = 'native';
    process.env.NO_PROXY = process.env.no_proxy = '127.0.0.1';
    const args = ['--config', 'GDAL_DISABLE_READDIR_ON_OPEN', 'EMPTY_DIR',
        '--config', 'GDAL_HTTP_TIMEOUT', '5', '-q', '-of', 'GTiff', url];
    for (const setting of ['NIX_SSL_CERT_FILE', 'SSL_CERT_FILE', 'CURL_CA_BUNDLE']) {
        delete process.env.CURL_CA_BUNDLE;
        delete process.env.SSL_CERT_FILE;
        process.env.NIX_SSL_CERT_FILE = unrelated;
        process.env[setting] = cert;
        if (setting === 'CURL_CA_BUNDLE') process.env.SSL_CERT_FILE = unrelated;
        const pool = await GdalPool.create(1);
        try {
            const native = path.join(work, `${setting}.tif`), cli = path.join(work, `${setting}-cli.tif`);
            await gdalCli('gdal_translate', [...args, cli]);
            await pool.command('gdal_translate', [...args, native]);
            assert.deepEqual(await fs.readFile(native), data);
            assert.deepEqual(await fs.readFile(native), await fs.readFile(cli));
            // A valid but unrelated CA bundle must fail, never trigger an insecure retry.
            await assert.rejects(pool.command('gdal_translate', ['--config', 'CURL_CA_BUNDLE', unrelated,
                ...args, path.join(work, 'untrusted.tif')]), /certificate|issuer|SSL/i);
            // Failed TLS requests and temporary trust settings must not poison reuse.
            await pool.command('gdal_translate', [...args, path.join(work, 'recovered.tif')]);
        } finally { await pool.close(); }
    }
    assert.ok(ranges >= 9, 'both execution paths must read the raster over HTTPS ranges');
});
