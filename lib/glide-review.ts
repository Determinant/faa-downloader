import type { Bounds } from './glide-model.ts';
import type { previewFeature } from './glide-preview.ts';

type Feature = ReturnType<typeof previewFeature>;
export type GlideReviewScene = { id: string; title: string; bounds: Bounds;
    contexts?: { label: string; bounds: Bounds }[];
    probes?: { label: string; coordinate: [number, number]; expected: 'excluded' | 'review' }[] };
const inside = ([x, y]: number[], [w, s, e, n]: Bounds) => x >= w && x <= e && y >= s && y <= n;
function contains(feature: Feature, [x, y]: number[]): boolean {
    if (!inside([x, y], feature.bbox)) return false;
    let result = false;
    for (const ring of feature.geometry.coordinates) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j], b = ring[i];
        if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
    }
    return result;
}

/** Review metrics are deliberately not a glide-range or aircraft-suitability score. */
export function reviewGlideFeatures(features: Feature[], scene: GlideReviewScene) {
    const points = features.map(f => f.properties.fitCenter ?? [(f.bbox[0] + f.bbox[2]) / 2, (f.bbox[1] + f.bbox[3]) / 2]);
    // Single-link groups reduce chunk/overlap inflation; they do not establish independent landing options.
    const parents = points.map((_, i) => i), root = (i: number): number => {
        while (parents[i] !== i) { parents[i] = parents[parents[i]]; i = parents[i]; } return i;
    };
    const metersLat = 111195, metersLon = metersLat * Math.cos((scene.bounds[1] + scene.bounds[3]) / 2 * Math.PI / 180);
    const bins = new Map<string, number[]>();
    for (let i = 0; i < points.length; i++) {
        const [lon, lat] = points[i], x = lon * metersLon / 1852, y = lat * metersLat / 1852;
        const bx = Math.floor(x), by = Math.floor(y);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const j of bins.get(`${bx + dx},${by + dy}`) ?? []) {
            if (Math.hypot((lon - points[j][0]) * metersLon, (lat - points[j][1]) * metersLat) <= 1852) parents[root(i)] = root(j);
        }
        const key = `${bx},${by}`, list = bins.get(key) ?? []; list.push(i); bins.set(key, list);
    }
    const flags: Record<string, number> = {};
    for (const bit of [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024]) flags[bit] = features.filter(f => f.properties.flags & bit).length;
    // A geographic gap sample is useful for comparison, but includes water/unassessed land.
    let samples = 0, beyond3Nm = 0, furthestNm = 0;
    for (let y = scene.bounds[1]; y < scene.bounds[3]; y += 1000 / metersLat) {
        for (let x = scene.bounds[0]; x < scene.bounds[2]; x += 1000 / metersLon) {
            samples++;
            let nearest = Infinity;
            for (const p of points) nearest = Math.min(nearest, Math.hypot((x - p[0]) * metersLon, (y - p[1]) * metersLat) / 1852);
            beyond3Nm += Number(nearest > 3); furthestNm = Math.max(furthestNm, nearest);
        }
    }
    return { patches: features.length, preferred: features.filter(f => f.properties.tier === 2).length,
        purple: features.filter(f => f.properties.tier === 1).length, spatialGroupsWithin1Nm: new Set(points.map((_, i) => root(i))).size,
        flags, reviewContexts: (scene.contexts ?? []).map(c => ({ label: c.label, patchesWithFitCenterInside: points.filter(p => inside(p, c.bounds)).length })),
        geographicGapSample: { spacingM: 1000, samples, beyond3Nm, furthestNm: Number.isFinite(furthestNm) ? furthestNm : null,
            meaning: 'Distance to fit centers across the entire rectangle, including water. Not land coverage or terrain-aware reachability.' },
        probes: (scene.probes ?? []).map(p => ({ ...p, candidateIds: features.filter(f => contains(f, p.coordinate)).map(f => f.id) })) };
}
