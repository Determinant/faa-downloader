import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile, fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
function environment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, PROJ_NETWORK: 'OFF', GDAL_PAM_ENABLED: 'NO', GDAL_CACHEMAX: '128' };
    // Embedded GDAL can resolve a different default OpenSSL trust store inside
    // Node than its CLI does (notably on Nix). Supply the host's CA bundle to
    // both backends, preserving explicit trust settings and TLS verification.
    if (env.CURL_CA_BUNDLE === undefined && env.SSL_CERT_FILE === undefined) {
        const bundle = env.NIX_SSL_CERT_FILE ?? ['/etc/ssl/certs/ca-certificates.crt',
            '/etc/pki/tls/certs/ca-bundle.crt', '/etc/ssl/cert.pem'].find(existsSync);
        if (bundle !== undefined) env.CURL_CA_BUNDLE = bundle;
    }
    return env;
}
const context = new AsyncLocalStorage<GdalPool>();
type Reply = { version?: string; result?: string; error?: string };
const nativeTools = new Set(['gdalinfo', 'ogrinfo', 'gdalwarp', 'gdal_translate', 'ogr2ogr',
    'gdal_rasterize', 'gdalbuildvrt', 'gdaladdo', 'gdal']);

/** Explicit reference/fallback implementation, also used for CLI capability checks. */
export async function gdalCli(command: string, args: string[]): Promise<string> {
    try {
        return (await exec(command, args, { maxBuffer: 16 * 1024 * 1024, env: environment() })).stdout;
    } catch (error) {
        throw new Error(`${command} failed: ${String(error.stderr || error.message).trim()}`, { cause: error });
    }
}

/** One native command at a time in an isolated, reusable Node process. */
class GdalProcess {
    private child: ChildProcess;
    private pending?: { resolve: (reply: Reply) => void; reject: (error: Error) => void };
    private failure?: Error;
    private diagnostics = '';
    readonly ready: Promise<Reply>;
    readonly exited: Promise<void>;
    constructor(library: string) {
        this.ready = new Promise((resolve, reject) => { this.pending = { resolve, reject }; });
        // Node 24 strips this worker's TS directly; no tsx loader or Python runtime.
        this.child = fork(fileURLToPath(new URL('./gdal-worker.ts', import.meta.url)), [library], {
            execArgv: [], env: environment(), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        this.child.stderr!.on('data', data => { this.diagnostics = (this.diagnostics + data.toString()).slice(-16_384); });
        this.child.on('error', error => this.fail(error));
        this.child.on('message', (reply: Reply) => {
            if (!this.pending || !reply || typeof reply !== 'object') {
                this.fail(new Error('Unexpected GDAL worker response')); this.child.kill(); return;
            }
            const pending = this.pending;
            this.pending = undefined;
            pending.resolve(reply);
        });
        this.exited = new Promise(resolve => {
            this.child.on('exit', (code, signal) => {
                this.fail(new Error(`GDAL worker exited (${signal ?? code}): ${this.diagnostics.trim()}`));
                this.child.stderr?.destroy();
                resolve();
            });
            this.child.on('error', () => { if (!this.child.pid) resolve(); });
        });
        const timer = setTimeout(() => {
            this.fail(new Error('GDAL Node worker startup timed out')); this.child.kill('SIGKILL');
        }, 15_000);
        void this.ready.then(() => clearTimeout(timer), () => clearTimeout(timer));
    }
    private fail(error: Error) {
        this.failure ??= error;
        this.pending?.reject(error);
        this.pending = undefined;
    }
    async command(command: string, args: string[]): Promise<string> {
        if (this.failure) throw this.failure;
        if (this.pending) throw new Error('Concurrent request to one GDAL process');
        this.diagnostics = '';
        const reply = await new Promise<Reply>((resolve, reject) => {
            this.pending = { resolve, reject };
            this.child.send({ command, args }, error => { if (error) this.fail(error); });
        });
        if (reply.error) throw new Error(`${command} failed: ${reply.error}`);
        if (typeof reply.result !== 'string') throw new Error('Invalid GDAL worker response');
        return reply.result;
    }
    get failed(): boolean { return !!this.failure; }
    async close(): Promise<void> {
        if (this.child.connected) this.child.disconnect();
        const timer = setTimeout(() => this.child.kill('SIGKILL'), 5000);
        try { await this.exited; } finally { clearTimeout(timer); }
    }
}

async function libraryCandidates(): Promise<string[]> {
    const candidates = new Set<string>();
    // Search alongside the actual executable, including symlinked Nix/Homebrew installs.
    for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
        const executable = await fs.realpath(path.join(directory, 'gdalinfo')).catch(() => undefined);
        if (!executable) continue;
        const lib = path.resolve(path.dirname(executable), '../lib');
        for (const name of (await fs.readdir(lib).catch(() => []))) {
            if (/^libgdal\.(?:so(?:\.\d+)*|dylib)$/.test(name)) candidates.add(await fs.realpath(path.join(lib, name)));
        }
    }
    for (const name of ['libgdal.so', 'libgdal.dylib', 'gdal.dll']) candidates.add(name);
    return [...candidates];
}

/** Shared bounded FIFO pool. No dataset cache: close/flush each output before acknowledgement. */
export class GdalPool {
    private slots: { process: GdalProcess; busy: boolean }[] = [];
    private waiting: (() => void)[] = [];
    private active = 0;
    private closing?: Promise<void>;
    private drained?: () => void;
    private constructor(readonly library: string | null, readonly versions: readonly string[],
        readonly fallbackReason: string | undefined, private concurrency: number, first?: GdalProcess) {
        if (first) this.slots.push({ process: first, busy: false });
    }

    static async create(concurrency: number, options: { library?: string | null; tools?: readonly string[];
        /** Already verified in the parent; every child still verifies its loaded library. */
        version?: string } = {}): Promise<GdalPool> {
        if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) throw new Error('Invalid GDAL pool size');
        const versions = options.version ? [options.version] :
            await Promise.all((options.tools ?? ['gdalinfo']).map(tool => gdalCli(tool, ['--version']).then(v => v.trim())));
        const expected = versions[0];
        if (!expected) throw new Error('GDAL pool needs at least one tool');
        if (options.library === null || process.env.GDAL_BACKEND === 'cli') return new GdalPool(null, versions, 'CLI selected', concurrency);
        if (!versions.every(v => v === expected)) {
            if (options.library || process.env.GDAL_LIBRARY || process.env.GDAL_BACKEND === 'native') throw new Error('GDAL CLI versions differ');
            return new GdalPool(null, versions, 'GDAL CLI versions differ', concurrency);
        }
        const explicit = options.library ?? process.env.GDAL_LIBRARY;
        let lastError: unknown;
        for (const library of explicit ? [explicit] : await libraryCandidates()) {
            const worker = new GdalProcess(library);
            try {
                const reply = await worker.ready;
                if (reply.error) throw new Error(reply.error);
                if (reply.version?.trim() !== expected) throw new Error(`GDAL library must match ${expected}; got ${reply.version}`);
                return new GdalPool(library, versions, undefined, concurrency, worker);
            } catch (error) { lastError = error; await worker.close(); }
        }
        if (explicit || process.env.GDAL_BACKEND === 'native') throw new Error(`Cannot load matching native GDAL: ${String(lastError)}`);
        return new GdalPool(null, versions, String(lastError), concurrency);
    }

    get version(): string { return this.versions[0]; }

    run<T>(task: () => Promise<T>): Promise<T> { return context.run(this, task); }

    async command(command: string, args: string[]): Promise<string> {
        if (this.closing) throw new Error('GDAL pool is closed');
        if (args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Invalid GDAL argument');
        if (this.active >= this.concurrency) await new Promise<void>(resolve => this.waiting.push(resolve));
        else this.active++;
        let slot: (typeof this.slots)[number] | undefined;
        try {
            // Global utility switches have no dataset operation; keep the installed CLI semantics.
            if (!this.library || !nativeTools.has(command) || args.some(a => ['--version', '--formats', '--help'].includes(a))) {
                return await gdalCli(command, args);
            }
            slot = this.slots.find(item => !item.busy);
            if (!slot) { slot = { process: new GdalProcess(this.library), busy: false }; this.slots.push(slot); }
            slot.busy = true;
            const ready = await slot.process.ready;
            if (ready.error || ready.version?.trim() !== this.version) throw new Error(ready.error || 'GDAL worker version changed');
            return await slot.process.command(command, args);
        } finally {
            if (slot) {
                slot.busy = false;
                if (slot.process.failed) { this.slots.splice(this.slots.indexOf(slot), 1); await slot.process.close(); }
            }
            const next = this.waiting.shift();
            if (next) next();
            else if (--this.active === 0) this.drained?.();
        }
    }

    /** Reject new work, drain accepted/queued jobs, then release all native processes. */
    close(): Promise<void> {
        return this.closing ??= (async () => {
            if (this.active) await new Promise<void>(resolve => { this.drained = resolve; });
            await Promise.all(this.slots.map(slot => slot.process.close()));
        })();
    }
}

export function gdalWorkerSettings(): { library: string | null; version?: string } {
    const pool = context.getStore();
    return { library: pool?.library ?? null, version: pool?.version };
}

/** CLI argument order is preserved: options first, input/output paths last.
 * buildvrt and addo additionally accept their documented input-list/overview forms.
 */
export function gdalCommand(command: string, args: string[]): Promise<string> {
    return context.getStore()?.command(command, args) ?? gdalCli(command, args);
}

/** Nested chart operations reuse their enclosing pool; standalone commands still work. */
export async function withGdal<T>(concurrency: number, task: () => Promise<T>, tools?: readonly string[]): Promise<T> {
    if (context.getStore()) return task();
    const pool = await GdalPool.create(concurrency, { tools });
    if (!pool.library && pool.fallbackReason !== 'CLI selected') console.warn(`GDAL: CLI fallback (${pool.fallbackReason})`);
    try { return await pool.run(task); } finally { await pool.close(); }
}
