#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import sharp from 'sharp';
import { addLocalSearchSupport } from './lib/aim-search.ts';
import { relativeOutputReference } from './lib/fs-utils.ts';
import { mapWithConcurrency } from './lib/concurrency.ts';

const DEFAULT_BASE_URL = 'https://www.faa.gov/air_traffic/publications/atpubs/aim_html/';
const DEFAULT_OUTPUT = 'dist/aim';
const DEFAULT_CONCURRENCY = 6;
const MAX_RETRIES = 3;
const PWA_THEME_COLOR = '#075b73';
const AIM_PWA_ID = './aim-pwa';
type DownloadResult = {
    url: URL;
    filePath: string;
    bytes: number;
    links: string[];
};
const AIM_ICON_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${PWA_THEME_COLOR}"/>
  <path d="M0 382 256 338l256 44v130H0z" fill="#06495e"/>
  <path d="M166 147a104 104 0 0 1 180 0M154 126l8 35 34-11M358 126l-8 35-34-11" fill="none" stroke="#64d4e8" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="m256 43 17 47-17 35-17-35z" fill="#f6bd3b"/>
  <path d="M256 117v52" stroke="#fff7e6" stroke-width="7" stroke-linecap="round"/>
  <text x="256" y="321" fill="#fffdf6" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="146" font-weight="800" letter-spacing="-5" text-anchor="middle">AIM</text>
  <path d="M54 442 205 390h102l151 52M205 390l-45 94M307 390l45 94" fill="none" stroke="#64d4e8" stroke-width="15" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M256 392v92" stroke="#f6bd3b" stroke-width="8" stroke-dasharray="13 12"/>
</svg>`;

function parseArgs(argv) {
    const args = {
        baseUrl: DEFAULT_BASE_URL,
        output: DEFAULT_OUTPUT,
        concurrency: DEFAULT_CONCURRENCY,
        clean: false,
        help: false
    };

    for (const arg of argv) {
        if (arg === '--clean') {
            args.clean = true;
        } else if (arg === '--help' || arg === '-h') {
            args.help = true;
        } else if (arg.startsWith('--base-url=')) {
            args.baseUrl = arg.slice('--base-url='.length);
        } else if (arg.startsWith('--output=')) {
            args.output = arg.slice('--output='.length);
        } else if (arg.startsWith('--concurrency=')) {
            args.concurrency = Number(arg.slice('--concurrency='.length));
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 32) {
        throw new Error('--concurrency must be an integer from 1 to 32');
    }

    return args;
}

function printHelp() {
    console.log(`Usage: node --import=tsx download-aim.ts [options]

Downloads the FAA AIM HTML site and its local assets into a staged local mirror.

Options:
  --output=DIR          Output directory (default: dist/aim)
  --base-url=URL       FAA AIM root URL
  --concurrency=N      Parallel downloads, 1-32 (default: 6)
  --clean              Replace an existing output directory after a successful download
  --help, -h           Show this help

Example:
  npm run build:aim
`);
}

function normalizeBaseUrl(raw) {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error(`Unsupported base URL protocol: ${url.protocol}`);
    }
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    url.search = '';
    url.hash = '';
    return url;
}

function isTextResource(url, contentType = '') {
    const lower = `${url.pathname} ${contentType}`.toLowerCase();
    return contentType.includes('text/') || /\.(?:html?|css|js|svg|xml)(?:$|\?)/.test(lower);
}

function decodeReference(raw) {
    return raw
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .trim();
}

function localUrl(raw, sourceUrl, baseUrl) {
    const ref = decodeReference(raw);
    if (!ref || ref.startsWith('#') || ref.startsWith('data:') || ref.startsWith('mailto:') || ref.startsWith('javascript:')) {
        return null;
    }

    let url;
    try {
        url = new URL(ref, sourceUrl);
    } catch {
        return null;
    }

    if (url.origin !== baseUrl.origin || !url.pathname.startsWith(baseUrl.pathname)) {
        return null;
    }

    // Fragments and query strings do not identify separate static files here.
    // Dropping them also prevents one download per in-page bookmark.
    url.search = '';
    url.hash = '';
    return url;
}

function relativeFilePath(url, baseUrl) {
    let relative = url.pathname.slice(baseUrl.pathname.length);
    if (!relative || relative.endsWith('/')) relative += 'index.html';

    try {
        relative = decodeURIComponent(relative);
    } catch {
        throw new Error(`Cannot decode FAA AIM path: ${url.pathname}`);
    }

    const normalized = path.posix.normalize(relative);
    if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../') || normalized.startsWith('/')) {
        throw new Error(`Unsafe FAA AIM path: ${url.pathname}`);
    }

    return normalized;
}

function toLocalReference(raw, sourceUrl, sourceFile, baseUrl) {
    const ref = decodeReference(raw);
    let fragment = '';
    try {
        fragment = new URL(ref, sourceUrl).hash;
    } catch {
        // localUrl() below will reject the reference as well.
    }

    const targetUrl = localUrl(ref, sourceUrl, baseUrl);
    if (!targetUrl) return raw;

    const targetFile = relativeFilePath(targetUrl, baseUrl);
    return `${relativeOutputReference(sourceFile, targetFile)}${fragment}`;
}

function mapSrcsetCandidates(raw, mapper) {
    return String(raw || '').split(',').map((candidate) => {
        const leading = candidate.match(/^\s*/)?.[0] || '';
        const trimmed = candidate.trim();
        if (!trimmed) return candidate;

        const match = trimmed.match(/^(\S+)([\s\S]*)$/);
        if (!match) return candidate;
        return `${leading}${mapper(match[1])}${match[2]}`;
    }).join(',');
}

function rewriteLocalReferences(text, sourceUrl, sourceFile, baseUrl) {
    let rewritten = text.replace(/\b(href|src|action)=(['"])(.*?)\2/gi, (match, attribute, quote, raw) => {
        const replacement = toLocalReference(raw, sourceUrl, sourceFile, baseUrl);
        return `${attribute}=${quote}${replacement}${quote}`;
    });

    rewritten = rewritten.replace(/\bsrcset=(['"])(.*?)\1/gi, (match, quote, raw) => {
        const replacement = mapSrcsetCandidates(raw, (candidate) => toLocalReference(candidate, sourceUrl, sourceFile, baseUrl));
        return `srcset=${quote}${replacement}${quote}`;
    });

    rewritten = rewritten.replace(/url\((\s*)(['"]?)([^)'"\s]+)\2(\s*)\)/gi, (match, leading, quote, raw, trailing) => {
        const replacement = toLocalReference(raw, sourceUrl, sourceFile, baseUrl);
        return `url(${leading}${quote}${replacement}${quote}${trailing})`;
    });

    rewritten = rewritten.replace(/@import\s+(['"])(.*?)\1/gi, (match, quote, raw) => {
        const replacement = toLocalReference(raw, sourceUrl, sourceFile, baseUrl);
        return `@import ${quote}${replacement}${quote}`;
    });

    return rewritten;
}

function findReferences(text, sourceUrl, baseUrl): Set<string> {
    const references = new Set<string>();
    const add = (raw: string) => {
        const url = localUrl(raw, sourceUrl, baseUrl);
        if (url) references.add(url.href);
    };

    for (const match of text.matchAll(/\b(?:href|src|action)=(['"])(.*?)\1/gi)) add(match[2]);
    for (const match of text.matchAll(/\bsrcset=(['"])(.*?)\1/gi)) {
        for (const candidate of String(match[2]).split(',')) {
            const url = candidate.trim().split(/\s+/, 1)[0];
            if (url) add(url);
        }
    }
    for (const match of text.matchAll(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi)) add(match[2]);
    for (const match of text.matchAll(/@import\s+(['"])(.*?)\1/gi)) add(match[2]);

    return references;
}

function outputPathFor(filePath, stagingDir) {
    const absolute = path.resolve(stagingDir, filePath);
    const root = path.resolve(stagingDir) + path.sep;
    if (!absolute.startsWith(root)) throw new Error(`Refusing to write outside staging directory: ${filePath}`);
    return absolute;
}

function buildServiceWorker({ cacheName, precache }) {
    return `/* Generated by download-aim.ts. */
const CACHE_NAME = ${JSON.stringify(cacheName)};
const PRECACHE_URLS = ${JSON.stringify(precache, null, 2)};

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(PRECACHE_URLS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys
                .filter((key) => key.startsWith('aim-shell-') && key !== CACHE_NAME)
                .map((key) => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.origin !== self.location.origin) return;

    const networkFirst = request.mode === 'navigate' || request.destination === 'document';
    const network = () => fetch(request).then((response) => {
        if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
    });

    event.respondWith(
        networkFirst
            ? network().catch(() => caches.match(request).then((cached) => cached || caches.match('./index.html')))
            : caches.match(request).then((cached) => cached || network())
    );
});
`;
}

export function buildAimManifest() {
    return {
        name: 'Aeronautical Information Manual',
        short_name: 'AIM',
        description: 'FAA basic flight information and air traffic control procedures.',
        id: AIM_PWA_ID,
        start_url: './index.html',
        scope: './',
        display: 'standalone',
        display_override: ['standalone', 'browser'],
        background_color: '#ffffff',
        theme_color: PWA_THEME_COLOR,
        lang: 'en-US',
        icons: [
            { src: 'icons/aim-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: 'icons/aim-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
        ]
    };
}

export function buildAimPrecache(downloadedFiles) {
    return [...new Set([
        './',
        ...downloadedFiles.map((file) => `./${file}`),
        './manifest.webmanifest',
        './icons/aim-icon.svg',
        './icons/aim-192.png',
        './icons/aim-512.png',
        './icons/apple-touch-icon.png'
    ])];
}

async function addPwaSupport(stagingDir, downloadedFiles, downloadedAt) {
    const pwaFiles = [
        'manifest.webmanifest',
        'service-worker.js',
        'icons/aim-icon.svg',
        'icons/aim-192.png',
        'icons/aim-512.png',
        'icons/apple-touch-icon.png'
    ];
    const iconDir = path.join(stagingDir, 'icons');
    await fs.mkdir(iconDir, { recursive: true });
    await fs.writeFile(path.join(iconDir, 'aim-icon.svg'), AIM_ICON_SVG);

    const icon = sharp(Buffer.from(AIM_ICON_SVG));
    await Promise.all([
        icon.clone().resize(192, 192).png().toFile(path.join(iconDir, 'aim-192.png')),
        icon.clone().resize(512, 512).png().toFile(path.join(iconDir, 'aim-512.png')),
        icon.clone().resize(180, 180).png().toFile(path.join(iconDir, 'apple-touch-icon.png'))
    ]);

    const manifest = buildAimManifest();
    await fs.writeFile(path.join(stagingDir, 'manifest.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`);

    const precache = buildAimPrecache(downloadedFiles);
    const cacheVersion = downloadedAt.replace(/\D/g, '');
    await fs.writeFile(
        path.join(stagingDir, 'service-worker.js'),
        buildServiceWorker({ cacheName: `aim-shell-${cacheVersion}`, precache })
    );

    const pwaMarker = '<!-- AIM PWA support -->';
    for (const file of downloadedFiles.filter((candidate) => candidate.endsWith('.html'))) {
        const filePath = path.join(stagingDir, file);
        let html = await fs.readFile(filePath, 'utf8');
        if (html.includes(pwaMarker)) continue;

        const manifestRef = relativeOutputReference(file, 'manifest.webmanifest');
        const iconRef = relativeOutputReference(file, 'icons/apple-touch-icon.png');
        const workerRef = relativeOutputReference(file, 'service-worker.js');
        const head = `${pwaMarker}
<link rel="manifest" href="${manifestRef}">
<link rel="apple-touch-icon" href="${iconRef}">
<meta name="theme-color" content="${PWA_THEME_COLOR}">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="AIM">
`;
        const worker = `${pwaMarker}
<script>
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('${workerRef}'));
}
</script>
`;

        if (!/<\/head>/i.test(html) || !/<\/body>/i.test(html)) {
            throw new Error(`Cannot add PWA metadata to ${file}`);
        }
        html = html.replace(/<\/head>/i, `${head}</head>`);
        html = html.replace(/<\/body>/i, `${worker}</body>`);
        await fs.writeFile(filePath, html);
    }

    return pwaFiles;
}

async function fetchResource(url) {
    let lastError;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
        try {
            const response = await fetch(url, {
                headers: { 'user-agent': 'faa-regs AIM mirror/1.0' },
                signal: AbortSignal.timeout(60_000)
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return {
                bytes: new Uint8Array(await response.arrayBuffer()),
                contentType: response.headers.get('content-type') || ''
            };
        } catch (error) {
            lastError = error;
            if (attempt < MAX_RETRIES) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
        }
    }
    throw new Error(`${url.href}: ${lastError?.message || 'download failed'}`);
}

async function downloadAim({ baseUrl, output, concurrency, clean }) {
    const outputPath = path.resolve(output);
    const parentDir = path.dirname(outputPath);
    let outputExists = true;
    try {
        await fs.access(outputPath);
    } catch (error) {
        if (error.code === 'ENOENT') outputExists = false;
        else throw error;
    }
    if (outputExists && !clean) {
        throw new Error(`Output directory already exists: ${outputPath}. Use --clean to replace it.`);
    }

    await fs.mkdir(parentDir, { recursive: true });
    const stagingDir = await fs.mkdtemp(path.join(parentDir, `.${path.basename(outputPath)}-download-`));
    const seedUrl = new URL('index.html', baseUrl);
    const pending: string[] = [seedUrl.href];
    const seen = new Set();
    let downloaded = 0;
    let totalBytes = 0;
    let backupPath = null;
    let installedOutput = false;

    try {
        while (pending.length > 0) {
            const batch: Array<{ url: URL; filePath: string }> = [];
            while (batch.length < concurrency && pending.length > 0) {
                const href = pending.shift();
                const url = new URL(href);
                const filePath = relativeFilePath(url, baseUrl);
                if (!seen.has(filePath)) {
                    seen.add(filePath);
                    batch.push({ url, filePath });
                }
            }

            const results = await mapWithConcurrency(batch, concurrency, async ({ url, filePath }): Promise<DownloadResult> => {
                const resource = await fetchResource(url);
                const text = isTextResource(url, resource.contentType)
                    ? new TextDecoder().decode(resource.bytes)
                    : null;
                const outputBytes = text === null
                    ? resource.bytes
                    : new TextEncoder().encode(rewriteLocalReferences(text, url, filePath, baseUrl));
                const destination = outputPathFor(filePath, stagingDir);
                await fs.mkdir(path.dirname(destination), { recursive: true });
                await fs.writeFile(destination, outputBytes);

                return {
                    url,
                    filePath,
                    bytes: outputBytes.byteLength,
                    links: text === null ? [] : [...findReferences(text, url, baseUrl)]
                };
            });

            for (const result of results) {
                downloaded += 1;
                totalBytes += result.bytes;
                pending.push(...result.links);
            }

            console.log(`Downloaded ${downloaded} file${downloaded === 1 ? '' : 's'} (${(totalBytes / 1048576).toFixed(1)} MiB)`);
        }

        const downloadedAt = new Date().toISOString();
        const localSearch = await addLocalSearchSupport(stagingDir, [...seen]);
        const siteFiles = [...seen, ...localSearch.searchFiles];
        const pwaFiles = await addPwaSupport(stagingDir, siteFiles, downloadedAt);
        const manifest = {
            source: baseUrl.href,
            downloadedAt,
            files: [...seen].sort(),
            fileCount: seen.size,
            bytes: totalBytes,
            localSearch: {
                entryCount: localSearch.entryCount,
                files: localSearch.searchFiles
            },
            pwaFiles
        };
        await fs.writeFile(path.join(stagingDir, 'download-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

        // mkdtemp() creates the staging root as 0700. Normalize it before the
        // atomic install so the web server can traverse the published mirror.
        await fs.chmod(stagingDir, 0o755);

        if (outputExists) {
            // Keep the backup beside the output so the final rename stays on
            // one filesystem. This also makes replacement recoverable if the
            // caller wants to restore the previous mirror manually.
            backupPath = path.join(parentDir, `.${path.basename(outputPath)}-backup-${Date.now()}`);
            await fs.rename(outputPath, backupPath);
        }

        await fs.rename(stagingDir, outputPath);
        installedOutput = true;
        console.log(`Wrote ${downloaded} files to ${outputPath}`);
        if (backupPath) console.log(`Previous mirror preserved at ${backupPath}`);
    } catch (error) {
        await fs.rm(stagingDir, { recursive: true, force: true });
        if (backupPath && !installedOutput) {
            try {
                await fs.access(outputPath);
            } catch {
                try {
                    await fs.rename(backupPath, outputPath);
                    console.warn(`Restored previous AIM mirror at ${outputPath}`);
                } catch (restoreError) {
                    console.error(`⚠️ Could not restore previous AIM mirror: ${restoreError.message}`);
                }
            }
        }
        throw error;
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        return;
    }

    const baseUrl = normalizeBaseUrl(args.baseUrl);
    if (!baseUrl.pathname.endsWith('/aim_html/')) {
        console.warn(`Warning: base URL does not look like FAA AIM HTML: ${baseUrl.href}`);
    }

    console.log(`Source: ${baseUrl.href}`);
    console.log(`Output: ${path.resolve(args.output)}`);
    await downloadAim({ ...args, baseUrl });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(`Error: ${error.message}`);
        process.exitCode = 1;
    });
}

export { findReferences, rewriteLocalReferences };
