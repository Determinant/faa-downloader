import { GLIDE_RULES as RULES, type GlideGrid } from './glide-model.ts';
import type { GlideSurface } from './glide-raster.ts';

export type GlidePolygon = { type: 'Polygon'; coordinates: number[][][] };

function signedRingArea(ring: number[][]): number {
    const [ox, oy] = ring[0];
    let area = 0;
    // Translate first: large northings need not consume area precision.
    for (let i = 1; i < ring.length; i++) area +=
        (ring[i - 1][0] - ox) * (ring[i][1] - oy) - (ring[i][0] - ox) * (ring[i - 1][1] - oy);
    return area / 2;
}

const ringArea = (ring: number[][]) => Math.abs(signedRingArea(ring));

/** Keep extent-defining points and turns that persist beyond individual raster
 * steps. Sample by original boundary distance so dense and sparse edges use the
 * same physical scale. Anchors remain fixed throughout all shortcut attempts. */
function outlineAnchors(ring: number[][]): Uint8Array {
    const count = ring.length - 1, anchors = new Uint8Array(count);
    const distances = new Float64Array(count + 1);
    for (let i = 0; i < count; i++) distances[i + 1] = distances[i] +
        Math.hypot(ring[i + 1][0] - ring[i][0], ring[i + 1][1] - ring[i][1]);
    const perimeter = distances[count];
    if (!perimeter) return anchors.fill(1);
    const sample = (distance: number) => {
        const position = ((distance % perimeter) + perimeter) % perimeter;
        let lo = 0, hi = count;
        while (lo + 1 < hi) {
            const mid = (lo + hi) >>> 1;
            if (distances[mid] <= position) lo = mid;
            else hi = mid;
        }
        const t = (position - distances[lo]) / (distances[lo + 1] - distances[lo]);
        return [ring[lo][0] + t * (ring[lo + 1][0] - ring[lo][0]),
            ring[lo][1] + t * (ring[lo + 1][1] - ring[lo][1])];
    };
    const reach = Math.min(RULES.displayAnchorReachM, perimeter / 4);
    const cosine = Math.cos(RULES.displayAnchorTurnDegrees * Math.PI / 180);
    const shallowCosine = Math.cos(Math.PI / 180);
    for (let i = 0; i < count; i++) {
        const before = sample(distances[i] - reach), after = sample(distances[i] + reach);
        const ax = ring[i][0] - before[0], ay = ring[i][1] - before[1];
        const bx = after[0] - ring[i][0], by = after[1] - ring[i][1];
        const dot = ax * bx + ay * by, lengths = Math.hypot(ax, ay) * Math.hypot(bx, by);
        if (dot <= cosine * lengths) anchors[i] = 1;
        else if (dot <= shallowCosine * lengths) {
            // A shallow corner between two long straight reaches still defines
            // the shape. Quarter samples distinguish it from a small tooth or
            // smooth curve. Allow 25 cm for source coordinate quantization.
            const straight = (direction: number, end: number[]) => {
                const dx = end[0] - ring[i][0], dy = end[1] - ring[i][1], length = Math.hypot(dx, dy);
                for (const fraction of [0.25, 0.5, 0.75]) {
                    const p = sample(distances[i] + direction * reach * fraction);
                    if (Math.abs((p[0] - ring[i][0]) * dy - (p[1] - ring[i][1]) * dx) > 0.25 * length) return false;
                }
                return true;
            };
            if (straight(-1, before) && straight(1, after)) anchors[i] = 1;
        }
    }
    for (const axis of [0, 1]) for (const direction of [-1, 1]) {
        let extreme = 0;
        for (let i = 1; i < count; i++) {
            const difference = direction * (ring[i][axis] - ring[extreme][axis]);
            if (difference > 0 || difference === 0 && ring[i][1 - axis] < ring[extreme][1 - axis]) extreme = i;
        }
        anchors[extreme] = 1;
    }
    return anchors;
}

/** Cheap inward-only shortcuts, followed by exact topology/containment checks
 * in glide-areas. Outer convex corners shrink; concave hole corners enlarge the
 * exclusion. Preserve broad turns, extremities and large holes; only short local
 * edges may change. Check every skipped original point to bound accumulated
 * deviation. No hole is deleted; removed ground has one shared area budget. */
export function simplifyGlideOutline(polygon: GlidePolygon, toleranceM: number,
    maxAreaFraction: number = RULES.displayMaxAreaChangeFraction): GlidePolygon {
    const areas = polygon.coordinates.map(ringArea);
    let budget = Math.max(0, areas[0] - areas.slice(1).reduce((a, b) => a + b, 0)) * maxAreaFraction;
    const tolerance2 = toleranceM ** 2;
    // Spend the budget on small exclusion outlines before the outer boundary;
    // otherwise a large rugged shell can leave every tiny hole untouched.
    const order = areas.map((_, i) => i).sort((a, b) => Number(a === 0) - Number(b === 0) || areas[a] - areas[b] || a - b);
    const coordinates = polygon.coordinates.slice();
    for (const ringIndex of order) {
        const ring = polygon.coordinates[ringIndex];
        const count = ring.length - 1;
        if (count <= 3) continue;
        if (ringIndex > 0) {
            if (areas[ringIndex] > RULES.displayHoleMaxAreaM2) continue;
            let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
            for (const [x, y] of ring) {
                west = Math.min(west, x); east = Math.max(east, x);
                south = Math.min(south, y); north = Math.max(north, y);
            }
            if (Math.max(east - west, north - south) > RULES.displayHoleMaxSpanM) continue;
        }
        const anchors = ringIndex === 0 ? outlineAnchors(ring) : new Uint8Array(count);
        const orientation = Math.sign(signedRingArea(ring));
        const previous = Int32Array.from({ length: count }, (_, i) => (i + count - 1) % count);
        const next = Int32Array.from({ length: count }, (_, i) => (i + 1) % count);
        const removed = new Uint8Array(count), queued = new Uint8Array(count).fill(1);
        const queue = Array.from({ length: count }, (_, i) => i);
        // Bound work even for long nearly collinear rings. Partial reduction is
        // fine; it must never turn one complex field into quadratic build work.
        let comparisons = count * 32, remaining = count;
        for (let head = 0; head < queue.length && remaining > 3 && comparisons > 0; head++) {
            const i = queue[head]; queued[i] = 0;
            if (removed[i] || anchors[i]) continue;
            const p = previous[i], n = next[i], a = ring[p], b = ring[i], c = ring[n];
            const dx = c[0] - a[0], dy = c[1] - a[1], length2 = dx * dx + dy * dy;
            if (!length2) continue;
            const cross = (b[0] - a[0]) * dy - (b[1] - a[1]) * dx;
            const loss = cross * orientation * (ringIndex === 0 ? 1 : -1) / 2;
            if (loss < 0 || loss > budget) continue;
            // Area alone cannot protect a long thin arm or shallow broad bend.
            // Collinear points may still be removed over longer straight runs.
            if (loss > 0 && length2 > RULES.displayShortcutMaxSpanM ** 2) continue;
            let close = true;
            for (let j = (p + 1) % count; j !== n; j = (j + 1) % count) {
                if (--comparisons < 0) { close = false; break; }
                const x = ring[j][0] - a[0], y = ring[j][1] - a[1];
                const t = Math.max(0, Math.min(1, (x * dx + y * dy) / length2));
                if ((x - t * dx) ** 2 + (y - t * dy) ** 2 > tolerance2) { close = false; break; }
            }
            if (!close) continue;
            budget -= loss; remaining--; removed[i] = 1; next[p] = n; previous[n] = p;
            for (const j of [p, n]) if (!queued[j]) { queued[j] = 1; queue.push(j); }
        }
        if (remaining === count) continue;
        const result = ring.slice(0, count).filter((_, i) => !removed[i]);
        coordinates[ringIndex] = [...result, result[0]];
    }
    return { type: 'Polygon', coordinates };
}

/** Coordinates are in the analysis grid's metres. Qualification never uses this result. */
export function removeSmallGlideHoles(polygon: GlidePolygon, grid: GlideGrid,
    surface: Pick<GlideSurface, 'hazards' | 'known' | 'cover' | 'terrainBand'>): GlidePolygon {
    if (polygon.coordinates.length < 2) return polygon;
    const areas = polygon.coordinates.map(ringArea);
    const filledArea = areas[0] - areas.slice(1).reduce((a, b) => a + b, 0);
    let budget = filledArea * RULES.displayHoleMaxFilledFraction;
    const removable: number[] = [];
    for (let ring = 1; ring < areas.length; ring++) {
        if (areas[ring] > RULES.displayHoleMaxAreaM2) continue;
        let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
        for (const [x, y] of polygon.coordinates[ring]) {
            w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y);
        }
        if (Math.max(e - w, n - s) > RULES.displayHoleMaxSpanM) continue;
        const x0 = Math.floor((w - grid.west) / grid.cell), x1 = Math.floor((e - grid.west) / grid.cell);
        const y0 = Math.floor((grid.north - n) / grid.cell), y1 = Math.floor((grid.north - s) / grid.cell);
        if (x0 < 0 || y0 < 0 || x1 >= grid.width || y1 >= grid.height) continue;
        let protectedHole = false;
        // Deliberately check the entire small bounding box. This also keeps
        // holes next to a mapped hazard, without another geometry intersection.
        for (let y = y0; y <= y1 && !protectedHole; y++) for (let x = x0; x <= x1; x++) {
            const i = y * grid.width + x;
            // Tree/cover exclusions are meaningful even without a vector hazard.
            if (surface.hazards[i] || !surface.known[i] || !surface.cover[i] || surface.terrainBand?.[i] === 0) {
                protectedHole = true; break;
            }
        }
        if (!protectedHole) removable.push(ring);
    }
    // Remove the smallest first and bound the cumulative fill, even in a
    // perforated field. Long/narrow exclusions and larger holes always remain.
    removable.sort((a, b) => areas[a] - areas[b] || a - b);
    const removed = new Set<number>();
    for (const ring of removable) if (areas[ring] <= budget) { removed.add(ring); budget -= areas[ring]; }
    return { type: 'Polygon', coordinates: polygon.coordinates.filter((_, i) => !removed.has(i)) };
}
