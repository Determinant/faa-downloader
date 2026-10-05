import fs from 'node:fs';
import koffi from 'koffi';

const errorHandler = koffi.proto('void GdalErrorHandler(int level, int code, const char *message)');

/** Private to the GDAL child process. Calls the installed library, never a bundled GDAL.
 * Signatures/ownership: gdal_utils.h, gdal.h, gdalalgorithm.h and cpl_vsi.h.
 * Native operations are synchronous here; the parent remains asynchronous.
 */
export class NativeGdal {
    private lib: ReturnType<typeof koffi.load>;
    private functions = new Map<string, ReturnType<ReturnType<typeof koffi.load>['func']>>();
    constructor(library: string) {
        this.lib = koffi.load(library);
        // GDALClose acquired its error return in 3.7. Older chart installations
        // can still use the CLI path without invoking an incompatible signature.
        if (Number(this.call('const char *GDALVersionInfo(const char *)', 'VERSION_NUM')) < 3070000) {
            throw new Error('Native GDAL workers require GDAL 3.7 or newer');
        }
        this.call('void GDALAllRegister()');
    }
    private call(signature: string, ...args: unknown[]): any {
        let fn = this.functions.get(signature);
        if (!fn) { fn = this.lib.func(signature); this.functions.set(signature, fn); }
        return fn(...args);
    }
    version(): string { return this.call('const char *GDALVersionInfo(const char *)', '--version'); }
    private error(): Error {
        return new Error(this.call('const char *CPLGetLastErrorMsg()') || 'GDAL operation failed');
    }
    private require<T>(value: T): NonNullable<T> { if (!value) throw this.error(); return value!; }
    private close(dataset: unknown) {
        if (this.call('int GDALClose(void *)', dataset) !== 0) throw this.error();
    }
    private finish(dataset: unknown, usage: number): void {
        this.require(dataset);
        // Some utilities can return an output handle after a partial failure.
        // Match CLI/UseExceptions behavior, and always flush/close that handle.
        const failure = usage || this.call('int CPLGetLastErrorType()') >= 3 ? this.error() : undefined;
        try { this.close(dataset); } finally { if (failure) throw failure; }
    }
    private open(file: string, flags: number, options: string[] = []): unknown {
        return this.require(this.call('void *GDALOpenEx(const char *, uint32_t, const char **, const char **, const char **)',
            file, flags | 0x40 /* verbose errors */, null, [...options, null], null));
    }
    private options<T>(name: string, args: string[], run: (options: unknown) => T): T {
        const options = this.require(this.call(`void *${name}New(const char **, void *)`, [...args, null], null));
        try { return run(options); } finally { this.call(`void ${name}Free(void *)`, options); }
    }

    execute(command: string, original: string[]): string {
        this.call('void CPLErrorReset()');
        // Drivers often emit the useful cause before a generic open failure.
        // Capture synchronously: stderr and IPC can arrive in either order.
        let diagnostics = '';
        const handler = koffi.register((level: number, code: number, message: string) => {
            if (level >= 3) diagnostics = (diagnostics + message + '\n').slice(-16_384);
            this.call('void CPLDefaultErrorHandler(int, int, const char *)', level, code, message);
        }, koffi.pointer(errorHandler));
        this.call('void CPLPushErrorHandler(GdalErrorHandler *)', handler);
        try {
            return this.executeWithOptions(command, original);
        } catch (error) {
            const message = (error as Error).message;
            const details = diagnostics.trim();
            throw new Error(details ? details + (details.endsWith(message) ? '' : `\n${message}`) : message, { cause: error });
        } finally {
            this.call('void CPLPopErrorHandler()');
            koffi.unregister(handler);
        }
    }

    private executeWithOptions(command: string, original: string[]): string {
        const args: string[] = [], openOptions: string[] = [];
        const config = new Map<string, string | null>();
        // A persistent worker must not leak HTTP headers or per-command options
        // into its next job. Open options belong on GDALOpenEx, not utility options.
        try {
            for (let i = 0; i < original.length; i++) {
                if (original[i] === '--config') {
                    const key = original[++i], value = original[++i];
                    if (!key || value === undefined) throw new Error('Invalid GDAL --config');
                    if (!config.has(key)) config.set(key, this.call('const char *CPLGetConfigOption(const char *, const char *)', key, null));
                    this.call('void CPLSetConfigOption(const char *, const char *)', key, value);
                } else if (original[i] === '-oo') {
                    if (original[++i] === undefined) throw new Error('Missing GDAL open option');
                    openOptions.push(original[i]);
                } else args.push(original[i]);
            }
            return this.run(command, args, openOptions);
        } finally {
            // A later request for the same URL may carry a new If-Match revision.
            // Do not satisfy it from GDAL's process-wide cache of previous bytes.
            if (original.some(arg => arg.startsWith('/vsicurl/'))) this.call('void VSICurlClearCache()');
            for (const [key, value] of config) this.call('void CPLSetConfigOption(const char *, const char *)', key, value);
        }
    }

    private run(command: string, args: string[], openOptions: string[]): string {
        if (command === 'gdal') return this.polygonize(args);
        if (command === 'gdalbuildvrt') return this.buildVrt(args);
        if (command === 'gdaladdo') return this.overviews(args, openOptions);
        if (command === 'gdalinfo' || command === 'ogrinfo') {
            const source = this.open(args.at(-1)!, command === 'ogrinfo' ? 4 : 2, openOptions);
            const name = command === 'ogrinfo' ? 'GDALVectorInfo' : 'GDALInfo';
            try {
                return this.options(`${name}Options`, args.slice(0, -1), options => {
                    const value = this.require(this.call(`void *${name}(void *, void *)`, source, options));
                    try { return koffi.decode(value, 'char', -1); }
                    finally { this.call('void VSIFree(void *)', value); }
                });
            } finally { this.close(source); }
        }
        const vector = command === 'ogr2ogr', rasterize = command === 'gdal_rasterize';
        const input = args.at(vector ? -1 : -2)!, output = args.at(vector ? -2 : -1)!;
        const destination = output === '/vsistdout/' ? '/vsimem/gdal-result.json' : output;
        const name = { gdalwarp: 'GDALWarp', gdal_translate: 'GDALTranslate',
            gdal_rasterize: 'GDALRasterize', ogr2ogr: 'GDALVectorTranslate' }[command];
        if (!name) throw new Error(`Unsupported native GDAL command: ${command}`);
        const source = this.open(input, vector || rasterize ? 4 : 2, openOptions);
        try {
            this.options(`${name === 'GDALWarp' ? 'GDALWarpApp' : name}Options`, args.slice(0, -2), options => {
                const usage = [0];
                const dataset = name === 'GDALWarp' || vector ?
                    this.call(`void *${name}(const char *, void *, int, void **, void *, _Out_ int *)`,
                        destination, null, 1, [source], options, usage) : rasterize ?
                    this.call(`void *${name}(const char *, void *, void *, void *, _Out_ int *)`,
                        destination, null, source, options, usage) :
                    this.call(`void *${name}(const char *, void *, void *, _Out_ int *)`,
                        destination, source, options, usage);
                this.finish(dataset, usage[0]);
            });
            if (output !== '/vsistdout/') return '';
            const size = [0];
            const buffer = this.require(this.call('void *VSIGetMemFileBuffer(const char *, _Out_ uint64_t *, int)', destination, size, 0));
            if (Number(size[0]) > 16 * 1024 * 1024) throw new Error('GDAL response exceeds 16 MiB');
            return Buffer.from(koffi.decode(buffer, 'uint8_t', Number(size[0]))).toString('utf8');
        } finally {
            try { this.close(source); }
            finally { if (output === '/vsistdout/') this.call('int VSIUnlink(const char *)', destination); }
        }
    }

    private buildVrt(args: string[]): string {
        const options: string[] = [];
        const arities: Record<string, number> = { '-q': 0, '-strict': 0, '-overwrite': 0,
            '-resolution': 1, '-vrtnodata': 1, '-srcnodata': 1, '-input_file_list': 1 };
        let i = 0, files: string[] | undefined;
        while (args[i]?.startsWith('-')) {
            const option = args[i++], count = arities[option];
            if (count === undefined || i + count > args.length) throw new Error(`Unsupported VRT option: ${option}`);
            if (option === '-input_file_list') files = fs.readFileSync(args[i], 'utf8').trim().split(/\r?\n/);
            // The C utility always writes the named VRT; -overwrite is a CLI-only guard.
            else if (option !== '-overwrite') options.push(option, ...args.slice(i, i + count));
            i += count;
        }
        const output = args[i++], sources = files ?? args.slice(i);
        if (!output || !sources.length) throw new Error('VRT needs an output and input files');
        return this.options('GDALBuildVRTOptions', options, settings => {
            const usage = [0];
            const dataset = this.require(this.call('void *GDALBuildVRT(const char *, int, void **, const char **, void *, _Out_ int *)',
                output, sources.length, null, [...sources, null], settings, usage));
            this.finish(dataset, usage[0]);
            return '';
        });
    }

    private overviews(args: string[], openOptions: string[]): string {
        let i = 0, resampling = 'nearest';
        if (args[i] === '-r') { resampling = args[i + 1]; i += 2; }
        const input = args[i++], levels = args.slice(i).map(Number);
        if (!input || !levels.length || levels.some(n => !Number.isSafeInteger(n) || n <= 1)) throw new Error('Invalid GDAL overviews');
        const dataset = this.open(input, 3 /* raster/update */, openOptions);
        try {
            if (this.call('int GDALBuildOverviews(void *, const char *, int, const int *, int, const int *, void *, void *)',
                dataset, resampling, levels.length, levels, 0, null, null, null) !== 0) throw this.error();
        } finally { this.close(dataset); }
        return '';
    }

    private polygonize(args: string[]): string {
        if (args[0] !== 'raster' || args[1] !== 'polygonize') throw new Error('Unsupported GDAL algorithm');
        const registry = this.require(this.call('void *GDALGetGlobalAlgorithmRegistry()'));
        let raster: unknown, algorithm: unknown;
        try {
            raster = this.require(this.call('void *GDALAlgorithmRegistryInstantiateAlg(void *, const char *)', registry, 'raster'));
            algorithm = this.require(this.call('void *GDALAlgorithmInstantiateSubAlgorithm(void *, const char *)', raster, 'polygonize'));
            this.require(this.call('bool GDALAlgorithmParseCommandLineArguments(void *, const char **)', algorithm, [...args.slice(2), null]));
            this.require(this.call('bool GDALAlgorithmRun(void *, void *, void *)', algorithm, null, null));
            this.require(this.call('bool GDALAlgorithmFinalize(void *)', algorithm));
            return '';
        } finally {
            if (algorithm) this.call('void GDALAlgorithmRelease(void *)', algorithm);
            if (raster) this.call('void GDALAlgorithmRelease(void *)', raster);
            this.call('void GDALAlgorithmRegistryRelease(void *)', registry);
        }
    }
}
