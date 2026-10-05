import { NativeGdal } from './gdal-native.ts';

// A process isolates GDAL's global state and native failures from Node/DuckDB.
// IPC is separate from stdout, which GDAL utilities may write to themselves.
try {
    const gdal = new NativeGdal(process.argv[2]);
    process.send!({ version: gdal.version() });
    process.on('message', (message: { command: string; args: string[] }) => {
        try {
            const result = gdal.execute(message.command, message.args);
            if (Buffer.byteLength(result) > 16 * 1024 * 1024) throw new Error('GDAL response exceeds 16 MiB');
            process.send!({ result });
        } catch (error) { process.send!({ error: (error as Error).message }); }
    });
    process.on('disconnect', () => process.exit(0));
} catch (error) {
    process.send!({ error: (error as Error).message }, () => process.disconnect());
}
