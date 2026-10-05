import fs from 'node:fs/promises';
import path from 'node:path';
import { availableParallelism } from 'node:os';
import { Worker, isMarkedAsUntransferable, parentPort, workerData } from 'node:worker_threads';
import { parseConcurrency } from './concurrency.ts';
import { type GlideScreening } from './glide-analysis.ts';
import { findAdaptiveGlideLandingAreas } from './glide-areas.ts';
import { applyGlideHazards, readGlideGround, type GlideSurface } from './glide-raster.ts';
import { GdalPool, gdalWorkerSettings } from './gdal.ts';
import { type GlideRasterSources } from './glide-sources.ts';
import { glideGrid, type GlideChunk, type GlideLandingArea, type ResolvedRegion } from './glide-model.ts';

export type GlideChunkResult = { areas: GlideLandingArea[]; screening: GlideScreening | null };
type ChunkJob = {
    region: Omit<ResolvedRegion, 'loadHazards'>; sources: GlideRasterSources;
    chunk: GlideChunk; directory: string;
};
type HazardSources = ResolvedRegion['sources'];
type PreparedChunk = { surface: GlideSurface | null; screening: GlideScreening };
type Stage = { type: 'screen'; job: ChunkJob } | { type: 'finish'; job: ChunkJob; prepared: PreparedChunk };
type Request = Stage | { type: 'close' };
type Response = { result?: PreparedChunk | GlideChunkResult; error?: Error };

function transfers(surface?: GlideSurface | null): ArrayBuffer[] {
    return [...new Set(Object.values(surface ?? {}).flatMap(value => ArrayBuffer.isView(value) ? [value.buffer] : []))]
        .filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer && !isMarkedAsUntransferable(buffer));
}

/** Leave CPU and RAM headroom; never multiply per-job GDAL threads by ALL_CPUS. */
export function glideConcurrency(requested?: number): number {
    return requested === undefined ? Math.max(1, Math.min(16, Math.floor(availableParallelism() / 2),
        Math.floor(process.availableMemory() / (4 * 1024 ** 3)))) : parseConcurrency(requested, '--concurrency');
}

/** Bound regional downloads, GDAL preparation and queued chunk jobs separately. */
export function glideRegionConcurrency(requested?: number, chunks = glideConcurrency()): number {
    return requested === undefined ? Math.max(1, Math.min(8, chunks,
        Math.floor(process.availableMemory() / (8 * 1024 ** 3)))) : parseConcurrency(requested, '--region-concurrency');
}

async function analyze(stage: Stage): Promise<PreparedChunk | GlideChunkResult> {
    const { job } = stage;
    const directory = path.join(job.directory, job.chunk.id);
    const grid = glideGrid(job.chunk.bounds);
    if (stage.type === 'screen') {
        await fs.mkdir(directory);
        const screening: GlideScreening = { cells: 0, known: 0, cover: 0,
            coverMargin: 0, hazardFree: 0, terrain: 0, width: 0, longestUsableFt: 0 };
        return { surface: await readGlideGround(job.sources, grid, directory, screening), screening };
    }
    const { surface, screening } = stage.prepared;
    await applyGlideHazards(job.region, surface!, grid, directory, screening);
    return { areas: await findAdaptiveGlideLandingAreas(surface!, grid, directory, screening), screening };
}

if (workerData?.type === 'glide-chunk') {
    let gdal: Promise<GdalPool> | undefined;
    parentPort!.on('message', async (message: Request) => {
        if (message.type === 'close') {
            try { await (await gdal)?.close(); } finally { parentPort!.close(); }
            return;
        }
        try {
            const backend = await (gdal ??= GdalPool.create(1, workerData.gdal));
            const result = await backend.run(() => analyze(message));
            parentPort!.postMessage({ result } satisfies Response, 'surface' in result ? transfers(result.surface) : []);
        } catch (error) { parentPort!.postMessage({ error } satisfies Response); }
    });
}

type Pending = {
    resolve: (result: PreparedChunk | GlideChunkResult) => void; reject: (error: Error) => void;
};
type Slot = { worker: Worker; pending?: Pending; failed?: Error };

/** One FIFO pool across regions. The caller drains active/queued jobs before closing. */
export class GlideChunkWorkers {
    private slots: Slot[] = [];
    private active = 0;
    private waiting: (() => void)[] = [];
    private jobs = new Set<Promise<GlideChunkResult>>();
    private closing?: Promise<void>;
    constructor(readonly concurrency: number) { parseConcurrency(concurrency, '--concurrency'); }

    run(job: ChunkJob, hazards: () => Promise<HazardSources>): Promise<GlideChunkResult> {
        if (this.closing) return Promise.reject(new Error('Glide workers are closed'));
        const task = this.process(job, hazards);
        this.jobs.add(task);
        void task.then(() => this.jobs.delete(task), () => this.jobs.delete(task));
        return task;
    }

    private async process(job: ChunkJob, hazards: () => Promise<HazardSources>): Promise<GlideChunkResult> {
        try {
            const prepared = await this.stage({ type: 'screen', job }) as PreparedChunk;
            if (!prepared.surface) return { areas: [], screening: prepared.screening };
            // Waiting for network data owns no CPU slot. The caller bounds in-flight
            // chunks per region, including these parked, transferable surface arrays.
            const sources = await hazards();
            return await this.stage({ type: 'finish', job: { ...job, region: { ...job.region, sources } }, prepared }) as GlideChunkResult;
        } finally { await fs.rm(path.join(job.directory, job.chunk.id), { recursive: true, force: true }); }
    }

    private async stage(request: Stage): Promise<PreparedChunk | GlideChunkResult> {
        // All regions share this limit. Transfer the permit directly to the
        // oldest waiter so one region cannot monopolize newly available slots.
        if (this.active >= this.concurrency) await new Promise<void>(resolve => this.waiting.push(resolve));
        else this.active++;
        try { return await this.runAvailable(request); }
        finally {
            const next = this.waiting.shift();
            if (next) next();
            else this.active--;
        }
    }

    private async runAvailable(request: Stage): Promise<PreparedChunk | GlideChunkResult> {
        // Serial mode also makes debugging and timing the original execution path straightforward.
        if (this.concurrency === 1) return analyze(request);
        let slot = this.slots.find(slot => !slot.pending && !slot.failed);
        if (!slot) {
            if (this.slots.length >= this.concurrency) throw new Error('Glide worker capacity exceeded');
            slot = this.createSlot();
        }
        const chosen = slot;
        return new Promise((resolve, reject) => {
            chosen.pending = { resolve, reject };
            try { chosen.worker.postMessage(request, request.type === 'finish' ? transfers(request.prepared.surface) : []); }
            catch (error) { chosen.pending = undefined; reject(error); }
        });
    }

    private createSlot(): Slot {
        const slot: Slot = { worker: new Worker(new URL(import.meta.url), {
            workerData: { type: 'glide-chunk', gdal: gdalWorkerSettings() } }) };
        const fail = (error: Error) => {
            slot.failed = error;
            slot.pending?.reject(error);
            slot.pending = undefined;
        };
        slot.worker.on('error', fail);
        slot.worker.on('exit', code => fail(new Error(`Glide worker exited (${code})`)));
        slot.worker.on('message', (message: Response) => {
            const pending = slot.pending;
            if (!pending) return;
            slot.pending = undefined;
            if (message.error) pending.reject(message.error);
            else pending.resolve(message.result!);
        });
        this.slots.push(slot);
        return slot;
    }

    close(): Promise<void> {
        return this.closing ??= (async () => {
            // Drain both stages and pending acquisition before releasing native workers.
            await Promise.allSettled(this.jobs);
            await Promise.all(this.slots.map(slot => {
                if (slot.failed) return slot.worker.terminate();
                return new Promise<void>(resolve => {
                    slot.worker.once('exit', () => resolve());
                    slot.worker.postMessage({ type: 'close' } satisfies Request);
                });
            }));
            this.slots = [];
        })();
    }
}
