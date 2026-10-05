#!/usr/bin/env node
import { createGlidePreviewServer } from './lib/glide-preview.ts';
import { GLIDE_VERSION } from './lib/glide-model.ts';

let output = 'dist', port = 4177;
for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--output=')) output = arg.slice(9);
    else if (arg.startsWith('--port=')) port = Number(arg.slice(7));
    else if (arg === '--help' || arg === '-h') {
        console.log('Usage: npm run preview:glide -- [--output=dist] [--port=4177]\n' +
            'Read-only local map of completed glide checkpoints. No downloads or new analysis.\n' +
            'Map backgrounds require internet. The build may continue while previewing.');
        process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
}
if (!output.trim() || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid output or port');
const server = createGlidePreviewServer(output);
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`Glide preview v${GLIDE_VERSION}: http://127.0.0.1:${port}/\nReading ${output}/glide-cache/analysis-v${GLIDE_VERSION}; build data stays unchanged.`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { server.close(); server.closeAllConnections(); });
