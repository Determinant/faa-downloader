import { FT, GLIDE_RULES as RULES, inside, lengthTier, type GlideCorridor, type GlideGrid } from './glide-model.ts';
import { glideRectangleChecker } from './glide-fit.ts';
import type { GlideSurface } from './glide-raster.ts';

/** Preparation diagnostics only; never included in delivered shards. Counts include the analysis halo. */
export type GlideScreening = {
    cells: number; known: number; cover: number; coverMargin: number;
    hazardFree: number; terrain: number; width: number; longestUsableFt: number;
    skipped?: 'cover' | 'terrain';
    /** Counts overlap between sources; denominator is terrain-passing cells before hazards. */
    hazardLosses?: { source: string; cells: number }[];
};

export function glideCoverClear(surface: Pick<GlideSurface, 'known' | 'cover'>,
    width: number, height: number, stats?: GlideScreening): Uint8Array {
    if (surface.known.length !== width * height || surface.cover.length !== width * height) throw new Error('Glide cover/grid dimensions differ');
    if (stats) { stats.known = 0; stats.cover = 0; stats.coverMargin = 0; }
    const cover = surface.cover.slice();
    for (let i = 0; i < cover.length; i++) {
        cover[i] = Number(surface.known[i] && cover[i]);
        if (stats) { stats.known += Number(Boolean(surface.known[i])); stats.cover += cover[i]; }
    }
    // Cover clearance is checked around the oriented fit itself. Rounding it
    // into a second isotropic erosion used to reject adequately wide strips.
    if (stats) stats.coverMargin = stats.cover;
    return cover;
}

/** No interpolation of rejected cover, NoData, or local elevation extrema into clear ground. */
export function glideTerrainClear(surface: Pick<GlideSurface, 'known' | 'elevationMin' | 'elevationMax' | 'hazards'>,
    width: number, height: number, cover: Uint8Array, stats?: GlideScreening): Uint8Array {
    const { known, elevationMin: low, elevationMax: high, hazards } = surface;
    const clear = new Uint8Array(known.length);
    const neighbors: { offset: number; rise: number }[] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) {
        neighbors.push({ offset: dy * width + dx, rise: RULES.maxGrade * Math.hypot(dx, dy) * RULES.cellM / RULES.metricMargin });
    }
    for (let y = 1; y + 1 < height; y++) for (let x = 1; x + 1 < width; x++) {
        const i = y * width + x;
        if (!cover[i]) continue;
        if (hazards[i]) continue;
        if (stats) stats.hazardFree++;
        if (!Number.isFinite(low[i]) || !Number.isFinite(high[i]) ||
            high[i] < low[i] || high[i] - low[i] > RULES.maxCellReliefM) continue;
        let acceptable = true, minimum = low[i], maximum = high[i];
        const center = (high[i] + low[i]) / 2;
        for (const { offset, rise } of neighbors) {
            const j = i + offset;
            if (!known[j] || !Number.isFinite(low[j]) || !Number.isFinite(high[j])) { acceptable = false; break; }
            // Estimate grade between cell centers. Comparing opposite interval
            // extrema also charged within-cell relief against this 10 m run,
            // rejecting smooth slopes below the configured grade. Keep extrema
            // separately for both relief checks and the delivered maximum height.
            if (Math.abs(center - (high[j] + low[j]) / 2) > rise) {
                acceptable = false; break;
            }
            minimum = Math.min(minimum, low[j]); maximum = Math.max(maximum, high[j]);
        }
        if (acceptable && maximum - minimum <= RULES.maxNeighborhoodReliefM) {
            clear[i] = 1;
            if (stats) stats.terrain++;
        }
    }
    return clear;
}

/** 0 rejected, 1 strict, 2 rolling open ground, 3 more constrained landform.
 * A plane measures grade and undulation separately; it never changes elevations.
 * All native extrema and all nine known cells are required. */
export function glideTerrainBands(surface: Pick<GlideSurface, 'known' | 'elevationMin' | 'elevationMax' | 'hazards'>,
    width: number, height: number, cover: Uint8Array): Uint8Array {
    const bands = glideTerrainClear(surface, width, height, cover);
    const { known, elevationMin: low, elevationMax: high, hazards } = surface;
    const offsets: { offset: number; dx: number; dy: number }[] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) offsets.push({ offset: dy * width + dx, dx, dy });
    const z = new Float64Array(9);
    for (let y = 1; y + 1 < height; y++) for (let x = 1; x + 1 < width; x++) {
        const i = y * width + x;
        if (bands[i] || !cover[i] || hazards[i]) continue;
        let sum = 0, sx = 0, sy = 0, valid = true, minimum = Infinity, maximum = -Infinity;
        for (let k = 0; k < offsets.length; k++) {
            const { offset, dx, dy } = offsets[k], j = i + offset;
            if (!known[j] || !Number.isFinite(low[j]) || !Number.isFinite(high[j]) || high[j] < low[j]) { valid = false; break; }
            z[k] = (low[j] + high[j]) / 2;
            sum += z[k]; sx += dx * z[k]; sy += dy * z[k];
            minimum = Math.min(minimum, low[j]); maximum = Math.max(maximum, high[j]);
        }
        if (!valid) continue;
        // Symmetric 3×3 least squares: each axis has sum(offset²) = 6.
        const cx = sx / 6, cy = sy / 6, mean = sum / 9;
        const grade = Math.hypot(cx, cy) * RULES.metricMargin / RULES.cellM;
        const span = Math.abs(cx) + Math.abs(cy);
        let residual = 0;
        for (let k = 0; k < offsets.length; k++) {
            const { dx, dy } = offsets[k];
            residual = Math.max(residual, Math.abs(z[k] - mean - cx * dx - cy * dy));
        }
        const band = RULES.fallbackTerrain.findIndex(limit => grade <= limit.maxGrade &&
            residual <= limit.maxResidualM && high[i] - low[i] <= limit.maxCellResidualM + span &&
            maximum - minimum <= 2 * span + 2 * limit.maxResidualM + limit.maxCellResidualM);
        if (band >= 0) bands[i] = band + 2;
    }
    return bands;
}

/** Necessary length check only: disconnected small patches cannot hold a straight landing run. */
export function glideLongComponents(clear: Uint8Array, width: number, height: number): boolean {
    const required = (RULES.tiers[0].minimumLengthFt * FT * RULES.metricMargin +
        2 * (RULES.endClearanceFt * FT * RULES.metricMargin + 2)) / RULES.cellM;
    const queue = new Uint32Array(clear.length);
    for (let i = 0; i < clear.length; i++) {
        if (clear[i] !== 1) continue;
        let head = 0, tail = 1, minX = i % width, maxX = minX, minY = Math.floor(i / width), maxY = minY;
        queue[0] = i; clear[i] = 2;
        while (head < tail) {
            const j = queue[head++], x = j % width, y = Math.floor(j / width);
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            if ((maxX - minX + 1) ** 2 + (maxY - minY + 1) ** 2 >= required ** 2) {
                // This pass can only reject. Once one connected patch might fit,
                // let the later straight-fit proof decide; no need to flood all
                // remaining fields twice before terrain/hazard screening.
                for (let k = 0; k < clear.length; k++) if (clear[k] === 2) clear[k] = 1;
                return true;
            }
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const xx = x + dx, yy = y + dy, k = yy * width + xx;
                if (xx >= 0 && xx < width && yy >= 0 && yy < height && clear[k] === 1) {
                    clear[k] = 2; queue[tail++] = k;
                }
            }
        }
        // Include complete cell footprints. A large bounding box can be a false
        // positive (e.g. a bent valley); only the final straight sweeps can accept it.
        for (let j = 0; j < tail; j++) clear[queue[j]] = 0;
    }
    for (let i = 0; i < clear.length; i++) if (clear[i]) clear[i] = 1;
    return false;
}

type Candidate = { ax: number; ay: number; bx: number; by: number; lengthFt: number; widthFt: number; terrainLimit: number };
type GroundComponent = { label: number; left: number; top: number; right: number; bottom: number; angle?: number; fallback?: boolean };
type LandingGround = { labels: Uint32Array; qualifications: Map<number, GlideCorridor>; flags: Map<number, number> };

function surfaceFlagsAt(surface: GlideSurface, i: number): number {
    return (surface.cropDependent[i] ? 1 : 0) |
        (surface.shrubBand?.[i] ? surface.shrubBand[i] === 1 ? 2 : 6 : 0) |
        ((surface.terrainBand?.[i] ?? 1) > 1 ? 16 : 0) |
        (surface.urban?.[i] ? 32 : 0) | (surface.mixedOpen?.[i] ? 128 : 0) |
        (surface.buildingFallback?.[i] ? 64 : 0) | (surface.canopyUncertain?.[i] ? 8 : 0) |
        (surface.clearanceFallback?.[i] ? 256 : 0) | (surface.obstacleUncertain?.[i] ? 512 : 0) |
        (surface.coverUncertain?.[i] ? 1024 : 0);
}

function geographicDistance(a: [number, number], b: [number, number]): number {
    const rad = Math.PI / 180, dlat = (b[1] - a[1]) * rad, dlon = (b[0] - a[0]) * rad;
    const h = Math.sin(dlat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dlon / 2) ** 2;
    return 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Full oriented strip checks. Never join separated clear runs or average rejected cells. */
export function findGlideCorridors(surface: GlideSurface, grid: GlideGrid, stats?: GlideScreening): GlideCorridor[] {
    return [...findGlideLandingGround(surface, grid, stats).qualifications.values()];
}

function findGroundCorridors(surface: GlideSurface, grid: GlideGrid,
    components: { labels: Uint32Array; patches: GroundComponent[]; clear: Uint8Array;
        retain: (label: number, record: GlideCorridor, terrainLimit: number) => void }, stats?: GlideScreening): GlideCorridor[] {
    const { width, height, cell } = grid;
    const widths = [surface.fitWidthFt ?? RULES.widthFt];
    if (surface.alternativeWidthFt) widths.push(surface.alternativeWidthFt);
    const clear = components.clear;
    if (!components.patches.length) return [];
    const stripClear = glideRectangleChecker(clear, width, height);
    // Search gentler openings first inside each component, then the broader
    // landform only when the local target is unavailable. Reuse two integral
    // masks for all patches/headings; never run another raster/GDAL pass.
    let differentTerrain = false;
    const gentle = surface.alternativeWidthFt && surface.terrainBand ?
        Uint8Array.from(clear, (value, i) => {
            const eligible = Number(value && surface.terrainBand![i] <= 2);
            if (value && !eligible) differentTerrain = true;
            return eligible;
        }) : undefined;
    const gentleCheck = gentle && differentTerrain ? glideRectangleChecker(gentle, width, height) : stripClear;
    const coverMargin = (surface.coverClearanceM ?? RULES.coverBoundaryClearanceM) * RULES.metricMargin / cell;
    const cover = glideCoverClear(surface, width, height);
    // At zero extra margin, a full-width fit already proves cover clearance if
    // its mask is a subset of known eligible cover. Verify once, including for
    // caller-supplied screened masks; otherwise retain the independent check.
    const coverClear = coverMargin === 0 && clear.every((value, i) => !value || cover[i]) ?
        undefined : glideRectangleChecker(cover, width, height);
    const bins = new Map<number, Candidate>();
    const reserve = (RULES.endClearanceFt * FT * RULES.metricMargin + 2) / cell;
    const maxLength = RULES.maxUsableLengthM * RULES.metricMargin / cell;
    const minimumFt = surface.minimumLengthFt ?? RULES.tiers[0].minimumLengthFt;
    const minimum = minimumFt * FT * RULES.metricMargin / cell;
    const preferred = RULES.tiers[1].minimumLengthFt + Math.ceil(1 / FT);

    // Local ranking only: every disconnected patch can retain its own best
    // witness. Length is rewarded up to the target, then width; no distant field
    // can suppress the sole opening in another valley. Do not imply a probability.
    const score = (c: Candidate) => Math.min(c.lengthFt, surface.targetLengthFt ?? preferred) * Math.sqrt(c.widthFt) /
        (c.terrainLimit === 3 ? 1.3 : 1);
    const retain = (candidate: Candidate) => {
        const mx = (candidate.ax + candidate.bx) / 2, my = (candidate.ay + candidate.by) / 2;
        if (!inside(grid.bounds, ...grid.coordinate(mx, my))) return;
        const label = components.labels[Math.floor(my) * width + Math.floor(mx)];
        const old = bins.get(label);
        if (!old || score(candidate) > score(old) || score(candidate) === score(old) && candidate.lengthFt > old.lengthFt) bins.set(label, candidate);
    };

    // One full-width witness per connected patch is sufficient for area display.
    const patches = components.patches;
    // An identical broader mask can only repeat candidates with a lower score.
    const choices = (gentle ? differentTerrain ? [2, 3] : [2] : [Infinity])
        .flatMap(terrainLimit => widths.map(widthFt => ({ terrainLimit, widthFt })));
    const corners = [[0, 0], [width, 0], [0, height], [width, height]];
    for (const patch of patches) {
        // A wholly external component cannot own a retained midpoint. Keep the
        // halo in every mask and retain complete components crossing ownership.
        const [left, bottom] = grid.coordinate(patch.left, patch.bottom);
        const [right, top] = grid.coordinate(patch.right, patch.top);
        if (right < grid.bounds[0] || left > grid.bounds[2] || top < grid.bounds[1] || bottom > grid.bounds[3]) continue;
        // Cache only raw centerline runs, separately for each mask and heading.
        // Lazy population preserves early exits and search order. Bound retained
        // entries/numbers to avoid an unbounded cache on a fragmented component.
        const sweeps = new Map<Uint8Array, Map<number, Map<number, number[]>>>();
        let sweepCacheBytes = 0;
        const maxSweepCacheBytes = 2 * 1024 * 1024;
        const angles = [...new Set([patch.angle ?? 0, 0, 90,
            ...Array.from({ length: 180 / RULES.headingStepDegrees }, (_, i) => i * RULES.headingStepDegrees)])];
        const target = surface.targetLengthFt ? surface.targetLengthFt + Math.ceil(1 / FT) :
            patch.fallback || Math.hypot(patch.right - patch.left, patch.bottom - patch.top) * cell / FT < preferred ?
                minimumFt + Math.ceil(1 / FT) : preferred;
        for (const { terrainLimit, widthFt } of choices) {
            const fitClear = terrainLimit === 2 ? gentle! : clear;
            const fitCheck = terrainLimit === 2 ? gentleCheck : stripClear;
            if ((bins.get(patch.label)?.lengthFt ?? 0) >= target) break;
            const halfWidth = (widthFt * FT / 2 * RULES.metricMargin + RULES.areaInsetM + 1) / cell;
            // Principal direction first catches long oblique fields. Refine the
            // remaining headings only if the coarse search has not qualified it.
            let bestAngle = patch.angle ?? 0, bestRun = 0;
            for (let headingIndex = 0; headingIndex < angles.length + 4; headingIndex++) {
                const angle = headingIndex < angles.length ? angles[headingIndex] :
                    (bestAngle + [-4, -2, 2, 4][headingIndex - angles.length] + 180) % 180;
                if ((bins.get(patch.label)?.lengthFt ?? 0) >= target) break;
                const theta = angle * Math.PI / 180, dx = Math.cos(theta), dy = Math.sin(theta), nx = -dy, ny = dx;
                const ps = corners.map(([x, y]) => x * dx + y * dy), qs = corners.map(([x, y]) => x * nx + y * ny);
                const pmin = Math.min(...ps), pmax = Math.max(...ps), qmax = Math.max(...qs);
                const cornersHere = [[patch.left, patch.top], [patch.right, patch.top],
                    [patch.left, patch.bottom], [patch.right, patch.bottom]];
                const pp = cornersHere.map(([x, y]) => x * dx + y * dy), qq = cornersHere.map(([x, y]) => x * nx + y * ny);
                const qStep = 0.5, qOrigin = Math.min(...qs) + 0.5;
                const pStart = pmin + 0.5 + Math.max(0, Math.ceil(Math.min(...pp) - pmin - 0.5));
                const pEnd = Math.min(pmax, Math.max(...pp));
                const qStart = qOrigin + Math.max(0, Math.ceil((Math.min(...qq) - qOrigin) / qStep)) * qStep;
                let lines = sweeps.get(fitClear)?.get(angle);
                if (!lines && widths.length > 1 && sweepCacheBytes + 128 <= maxSweepCacheBytes) {
                    let headings = sweeps.get(fitClear);
                    if (!headings) sweeps.set(fitClear, headings = new Map());
                    headings.set(angle, lines = new Map());
                    sweepCacheBytes += 128;
                }
                for (let q = qStart; q < Math.min(qmax, Math.max(...qq)); q += qStep) {
                    if ((bins.get(patch.label)?.lengthFt ?? 0) >= target) break;
                    let start: number | undefined, last = 0;
                    const flush = () => {
                        if (start === undefined) return;
                        const usable = last - start - 2 * reserve;
                        if (headingIndex < angles.length && usable > bestRun) { bestRun = usable; bestAngle = angle; }
                        if (stats) stats.longestUsableFt = Math.max(stats.longestUsableFt, Math.floor(usable * cell / RULES.metricMargin / FT));
                        if (usable >= minimum) {
                            const length = Math.min(usable, maxLength), count = Math.ceil(usable / maxLength);
                            for (let k = 0; k < count; k++) {
                                const a = start + reserve + (count === 1 ? 0 : k * (usable - length) / (count - 1));
                                const b = a + length;
                                retain({ ax: a * dx + q * nx, ay: a * dy + q * ny,
                                    bx: b * dx + q * nx, by: b * dy + q * ny,
                                    lengthFt: Math.floor(length * cell / RULES.metricMargin / FT), widthFt, terrainLimit });
                            }
                        }
                        start = undefined;
                    };
                    // Most ragged patches cannot even fit a straight centerline. Skip
                    // their short runs before doing any full-width rectangle checks.
                    const checkRun = (rawStart: number, rawLast: number) => {
                        for (let p = rawStart; p <= rawLast; p++) {
                            const cx = p * dx + q * nx, cy = p * dy + q * ny;
                            if (fitCheck(cx, cy, dx, dy, 0.5, halfWidth) &&
                                (!coverClear || coverClear(cx, cy, dx, dy, 0.5 + coverMargin, halfWidth + coverMargin))) {
                                start ??= p; last = p;
                            } else flush();
                        }
                        flush();
                    };
                    const cached = lines?.get(q);
                    if (cached) {
                        for (let i = 0; i < cached.length; i += 2) checkRun(cached[i], cached[i + 1]);
                    } else {
                        let runs: number[] | undefined = lines && sweepCacheBytes + 128 <= maxSweepCacheBytes ? [] : undefined;
                        let rawStart: number | undefined, rawLast = 0;
                        const finishRun = () => {
                            if (rawStart !== undefined && rawLast - rawStart >= minimum + 2 * reserve) {
                                if (runs && sweepCacheBytes + 128 + (runs.length + 2) * 8 > maxSweepCacheBytes) runs = undefined;
                                runs?.push(rawStart, rawLast);
                                checkRun(rawStart, rawLast);
                            }
                            rawStart = undefined;
                        };
                        for (let p = pStart; p <= pEnd; p++) {
                            const x = Math.floor(p * dx + q * nx), y = Math.floor(p * dy + q * ny);
                            if (x >= patch.left && x < patch.right && y >= patch.top && y < patch.bottom &&
                                fitClear[y * width + x] && components.labels[y * width + x] === patch.label) {
                                rawStart ??= p; rawLast = p;
                            } else finishRun();
                        }
                        finishRun();
                        if (runs) { lines!.set(q, runs); sweepCacheBytes += 128 + runs.length * 8; }
                    }
                    flush();
                }
            }
        }
    }

    const records: GlideCorridor[] = [];
    for (const candidate of bins.values()) {
        const { ax, ay, bx, by, widthFt } = candidate;
        const a = grid.coordinate(ax, ay).map(v => Math.round(v * 1e6)) as [number, number];
        const b = grid.coordinate(bx, by).map(v => Math.round(v * 1e6)) as [number, number];
        // Quantization never promotes a length into a higher tier.
        const lengthFt = Math.min(candidate.lengthFt,
            Math.floor((geographicDistance([a[0] / 1e6, a[1] / 1e6], [b[0] / 1e6, b[1] / 1e6]) - 1) / FT));
        const tier = lengthTier(lengthFt);
        if (!tier || lengthFt < minimumFt) continue;
        const length = Math.hypot(bx - ax, by - ay), dx = (bx - ax) / length, dy = (by - ay) / length;
        const radius = widthFt * FT / 2 * RULES.metricMargin / cell;
        const cellProjection = (Math.abs(dx) + Math.abs(dy)) / 2;
        let elevation = -Infinity;
        let samples = 0, sx = 0, sy = 0, sz = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0;
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        const rx = Math.abs(dx) * (length / 2 + reserve) + Math.abs(dy) * radius;
        const ry = Math.abs(dy) * (length / 2 + reserve) + Math.abs(dx) * radius;
        for (let y = Math.max(0, Math.floor(my - ry)); y < Math.min(height, Math.ceil(my + ry)); y++) {
            for (let x = Math.max(0, Math.floor(mx - rx)); x < Math.min(width, Math.ceil(mx + rx)); x++) {
                const along = (x + 0.5 - ax) * dx + (y + 0.5 - ay) * dy;
                const across = -(x + 0.5 - ax) * dy + (y + 0.5 - ay) * dx;
                if (along >= -reserve - cellProjection && along <= length + reserve + cellProjection && Math.abs(across) <= radius + cellProjection) {
                    elevation = Math.max(elevation, surface.elevationMax[y * width + x]);
                    const px = (along - length / 2) * cell, py = across * cell;
                    const z = (surface.elevationMin[y * width + x] + surface.elevationMax[y * width + x]) / 2;
                    samples++; sx += px; sy += py; sz += z;
                    sxx += px * px; syy += py * py; sxy += px * py; sxz += px * z; syz += py * z;
                }
            }
        }
        if (!Number.isFinite(elevation)) throw new Error('Unknown elevation in retained glide corridor');
        // Overall least-squares grade of the inspected footprint, not maximum
        // local grade or a recommended landing direction. Local screening above
        // remains responsible for undulation and elevation extrema.
        const xx = sxx - sx * sx / samples, yy = syy - sy * sy / samples, xy = sxy - sx * sy / samples;
        const xz = sxz - sx * sz / samples, yz = syz - sy * sz / samples, determinant = xx * yy - xy * xy;
        if (!(determinant > 0)) throw new Error('Degenerate glide fit grade');
        const record: GlideCorridor = [...a, ...b, widthFt, lengthFt, Math.ceil(elevation), tier,
            Math.round(1000 * (xz * yy - yz * xy) / determinant), Math.round(1000 * (yz * xx - xz * xy) / determinant)];
        records.push(record);
        components.retain(components.labels[Math.floor((ay + by) / 2) * width + Math.floor((ax + bx) / 2)], record, candidate.terrainLimit);
    }
    return records.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
}

/** The displayed object is connected screened ground; the straight fit is only its qualification. */
export function findGlideLandingGround(surface: GlideSurface, grid: GlideGrid, stats?: GlideScreening, alreadyQualified?: Uint8Array): LandingGround {
    const { width, height } = grid;
    if (stats && !surface.screenedGround) Object.assign(stats, { cells: width * height, known: 0, cover: 0, coverMargin: 0,
        hazardFree: 0, terrain: 0, width: 0, longestUsableFt: 0, skipped: undefined });
    if (stats) { stats.width = 0; stats.longestUsableFt = 0; stats.skipped = undefined; }
    const ground = surface.screenedGround ?? glideTerrainClear(surface, width, height, glideCoverClear(surface, width, height, stats), stats);
    const clear = ground;
    const labels = new Uint32Array(ground.length), queue = new Uint32Array(ground.length);
    const patches: GroundComponent[] = [];
    const minimumSpan = ((surface.minimumLengthFt ?? RULES.tiers[0].minimumLengthFt) + 2 * RULES.endClearanceFt) * FT * RULES.metricMargin / grid.cell;
    let count = 0;
    const flags = new Map<number, number>();
    for (let i = 0; i < ground.length; i++) {
        if (!ground[i] || labels[i]) continue;
        const label = ++count;
        const patch: GroundComponent = { label, left: width, top: height, right: 0, bottom: 0 };
        let head = 0, tail = 1, surfaceFlags = (surface.fitWidthFt ?? RULES.widthFt) < RULES.widthFt ? 256 : 0,
            uncovered = false, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
        queue[0] = i; labels[i] = label;
        while (head < tail) {
            const j = queue[head++], x = j % width, y = Math.floor(j / width);
            if (!alreadyQualified?.[j]) uncovered = true;
            sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
            if (clear[j]) {
                patch.left = Math.min(patch.left, x); patch.top = Math.min(patch.top, y);
                patch.right = Math.max(patch.right, x + 1); patch.bottom = Math.max(patch.bottom, y + 1);
            }
            surfaceFlags |= surfaceFlagsAt(surface, j);
            // Corner contact does not connect two landing areas across excluded ground.
            const visit = (k: number) => {
                if (ground[k] && !labels[k]) { labels[k] = label; queue[tail++] = k; }
            };
            if (x) visit(j - 1);
            if (x + 1 < width) visit(j + 1);
            if (y) visit(j - width);
            if (y + 1 < height) visit(j + width);
        }
        flags.set(label, surfaceFlags);
        patch.angle = (Math.atan2(2 * (sxy - sx * sy / tail), sxx - sx * sx / tail - syy + sy * sy / tail) * 90 / Math.PI + 180) % 180;
        patch.fallback = Boolean(surfaceFlags & ~1);
        if (uncovered && tail >= minimumSpan * (surface.alternativeWidthFt ?? surface.fitWidthFt ?? RULES.widthFt) * FT * RULES.metricMargin / grid.cell &&
            patch.right > patch.left && Math.hypot(patch.right - patch.left, patch.bottom - patch.top) >= minimumSpan) patches.push(patch);
    }
    const qualifications = new Map<number, GlideCorridor>();
    const limits = new Map<number, number>();
    findGroundCorridors(surface, grid, { labels, patches, clear, retain: (label, record, terrainLimit) => {
        if (!label) throw new Error('Glide qualification is outside screened ground');
        // Surface uncertainty cannot be promoted by a long straight fit.
        if (flags.get(label)! & ~1) record[7] = 1;
        qualifications.set(label, record);
        limits.set(label, terrainLimit);
    } }, stats);
    // Do not grow a gentler witness into a steeper/bumpier hillside just because
    // they touch. Polygonization also removes separated lobes without a witness.
    let trimmed = false;
    for (let i = 0; i < labels.length; i++) {
        if (!qualifications.has(labels[i])) labels[i] = 0;
        else if ((surface.terrainBand?.[i] ?? 1) > limits.get(labels[i])!) { labels[i] = 0; trimmed = true; }
    }
    if (trimmed) {
        // Removing a broader-terrain connection may split a qualified parent.
        // Keep its witness's component and re-search every other surviving one.
        // Recovery contains only bands <=2, so it cannot trim again: one bounded
        // additional search, no repeated raster preparation or polygonization.
        const [west, north] = grid.coordinate(0, 0), [east, south] = grid.coordinate(1, 1);
        const witnessCells = new Map([...qualifications].map(([label, q]) => [label,
            Math.floor(((q[1] + q[3]) / 2e6 - north) / (south - north)) * width +
            Math.floor(((q[0] + q[2]) / 2e6 - west) / (east - west))]));
        const seen = new Uint8Array(labels.length), recovery = new Uint8Array(labels.length);
        for (let i = 0; i < labels.length; i++) {
            const label = labels[i];
            if (!label || seen[i] || limits.get(label) !== 2) continue;
            let head = 0, tail = 1, containsWitness = false, componentFlags = 256;
            queue[0] = i; seen[i] = 1;
            while (head < tail) {
                const j = queue[head++], x = j % width, y = Math.floor(j / width);
                containsWitness ||= j === witnessCells.get(label);
                componentFlags |= surfaceFlagsAt(surface, j);
                const visit = (k: number) => {
                    if (labels[k] === label && !seen[k]) { seen[k] = 1; queue[tail++] = k; }
                };
                if (x) visit(j - 1);
                if (x + 1 < width) visit(j + 1);
                if (y) visit(j - width);
                if (y + 1 < height) visit(j + width);
            }
            if (containsWitness) flags.set(label, componentFlags);
            else for (let k = 0; k < tail; k++) { recovery[queue[k]] = 1; labels[queue[k]] = 0; }
        }
        if (recovery.some(Boolean)) {
            const recoveredStats = stats && { ...stats };
            const recovered = findGlideLandingGround({ ...surface, screenedGround: recovery }, grid, recoveredStats, alreadyQualified);
            for (const [label, q] of recovered.qualifications) {
                qualifications.set(count + label, q); flags.set(count + label, recovered.flags.get(label)!);
            }
            for (let i = 0; i < labels.length; i++) if (recovered.labels[i]) labels[i] = count + recovered.labels[i];
            if (stats) stats.longestUsableFt = Math.max(stats.longestUsableFt, recoveredStats!.longestUsableFt);
        }
    }
    if (stats) stats.width = labels.reduce((sum, label) => sum + Number(label > 0), 0);
    return { labels, qualifications, flags };
}
