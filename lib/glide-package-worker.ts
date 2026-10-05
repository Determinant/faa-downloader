import { parentPort } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { jsonBytes, type SourceShard } from './glide-delivery.ts';
import { readSourceShard, type PinnedInput } from './glide-package-input.ts';
import { packageDetailShard } from './glide-package-detail.ts';
import { overviewMasks } from './glide-package-overview.ts';

export type PackageJob = { source: SourceShard; directory: string; schema: 8 | 9; cache: string;
    detailImplementation: string; overviewImplementation: string; force: boolean; zoom: number };
parentPort!.on('message', async (job: PackageJob) => {
    try {
        const input = { directory: job.directory, manifest: { schemaVersion: job.schema } } as PinnedInput;
        const areas = await readSourceShard(input, job.source), exact = createHash('sha256');
        areas.forEach((area, i) => exact.update(jsonBytes([`${job.source.sha256}:${i}`, area])));
        const detail = await packageDetailShard(areas, job.source, job.schema, job.cache, job.detailImplementation, job.force);
        const masks = await overviewMasks(areas, job.source.sha256, job.zoom, job.cache, job.overviewImplementation, job.force);
        parentPort!.postMessage({ detail, masks, records: areas.length, digest: exact.digest('hex') });
    } catch (error) { parentPort!.postMessage({ error: (error as Error).stack ?? String(error) }); }
});
