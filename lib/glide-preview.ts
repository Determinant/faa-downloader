import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { GLIDE_VERSION, type Bounds } from './glide-model.ts';
import { GlidePreviewData, GlidePreviewSamples, previewBounds, supportedVersion } from './glide-preview-data.ts';

export { GlidePreviewData, previewBounds, previewFeature } from './glide-preview-data.ts';

export function createGlidePreviewServer(output: string) {
    const samples = new GlidePreviewSamples(path.resolve(output));
    const data = new GlidePreviewData(path.resolve(output), GLIDE_VERSION, samples);
    const versions = new Map([[GLIDE_VERSION, data]]);
    const assets = new URL('../tools/glide-preview/', import.meta.url);
    const leaflet = path.dirname(createRequire(import.meta.url).resolve('leaflet'));
    const staticFiles = new Map([
        ['/', { file: new URL('index.html', assets), type: 'text/html; charset=utf-8' }],
        ['/app.js', { file: new URL('app.js', assets), type: 'text/javascript; charset=utf-8' }],
        ['/style.css', { file: new URL('style.css', assets), type: 'text/css; charset=utf-8' }],
        ['/vendor/leaflet.js', { file: pathToFileURL(path.join(leaflet, 'leaflet.js')), type: 'text/javascript' }],
        ['/vendor/leaflet.css', { file: pathToFileURL(path.join(leaflet, 'leaflet.css')), type: 'text/css' }],
    ]);
    return createServer(async (request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
        const json = (status: number, body: unknown) => {
            response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(body));
        };
        try {
            if (request.method !== 'GET') { json(405, { error: 'Read-only preview' }); return; }
            const url = new URL(request.url!, 'http://localhost');
            const asset = staticFiles.get(url.pathname);
            if (asset) { response.writeHead(200, { 'Content-Type': asset.type }); response.end(await fs.readFile(asset.file)); return; }
            if (url.pathname === '/api/samples') {
                json(200, await samples.list()); return;
            }
            if (url.pathname === '/api/versions') {
                const entries = await fs.readdir(path.join(data.output, 'glide-cache')).catch(error => {
                    if (error.code === 'ENOENT') return []; throw error;
                });
                const available = new Set([GLIDE_VERSION]);
                for (const entry of entries) {
                    const version = Number(entry.match(/^analysis-v(\d+)$/)?.[1]);
                    if (supportedVersion(version)) available.add(version);
                }
                for (const sample of await samples.list()) available.add(sample.version);
                json(200, { current: GLIDE_VERSION, versions: [GLIDE_VERSION,
                    ...[...available].filter(version => version !== GLIDE_VERSION).sort((a, b) => b - a)] }); return;
            }
            if (url.pathname === '/api/view') {
                let bounds: Bounds, zoom: number, version: number;
                try {
                    bounds = previewBounds(url.searchParams.get('bbox')); zoom = Number(url.searchParams.get('zoom') ?? '11');
                    if (!Number.isFinite(zoom) || zoom < 0 || zoom > 22) throw new Error('Invalid zoom');
                    version = Number(url.searchParams.get('version') ?? GLIDE_VERSION);
                    if (!supportedVersion(version)) throw new Error('Unsupported analysis version');
                } catch (error) { json(400, { error: error.message }); return; }
                if (!versions.has(version)) versions.set(version, new GlidePreviewData(data.output, version, samples));
                json(200, await versions.get(version)!.view(bounds, zoom, url.searchParams.get('sample'))); return;
            }
            json(404, { error: 'Not found' });
        } catch (error) {
            console.error('Glide preview:', error);
            if (!response.headersSent) json(500, { error: 'Could not read preview data. See the preview terminal for details.' });
            else response.end();
        }
    });
}
