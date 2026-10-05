import { rasterizeAreas } from '../lib/glide-package-overview.ts';
import type { Area } from '../lib/glide-delivery.ts';

// Analytic rectangles at three latitudes and twelve grid phases expose sampling
// error independently of the encoder. This is not an accuracy estimate for the
// national corpus. It excludes subsequent UInt8 rounding and pyramid reduction.
const radius = 6_371_008.8, radians = Math.PI / 180;
const results: object[] = [];
const popcount = (value: number) => { let count = 0; while (value) { value &= value - 1; count++; } return count; };
for (const zoom of [10, 11]) for (const widthM of [18.288, 30.48, 60.96, 300]) {
    const errors: number[] = [];
    for (const latitude of [25, 40, 49]) for (let phase = 0; phase < 12; phase++) {
        const span = 2 ** zoom * 1024, base = Math.floor((-110 + 180) / 360 * span);
        const west = (base + phase / 12) / span * 360 - 180;
        const east = west + widthM / (radius * Math.cos(latitude * radians)) / radians;
        const south = latitude, north = south + 600 / radius / radians;
        const [w, e, s, n] = [west, east, south, north].map(v => Math.round(v * 1e6));
        const area: Area = [[w, s, e, n, 60, 600, 0, 2], [[w, s, e - w, 0, 0, n - s, w - e, 0]], 0];
        const exact = (e - w) / 1e6 * radians * (Math.sin(n / 1e6 * radians) - Math.sin(s / 1e6 * radians)) * radius ** 2;
        let sampled = 0;
        for (const [key, mask] of rasterizeAreas([area], zoom)) {
            const ty = Number(key.split('/')[2]);
            for (let i = 0; i < mask.preferred.length; i++) if (mask.preferred[i]) {
                const row = ty * 1024 + Math.floor(i / 256) * 4;
                for (let k = 0; k < 4; k++) {
                    const weight = Math.tanh(Math.PI * (1 - 2 * (row + k) / span)) - Math.tanh(Math.PI * (1 - 2 * (row + k + 1) / span));
                    sampled += popcount((mask.preferred[i] >>> (k * 4)) & 15) * weight * 2 * Math.PI / span * radius ** 2;
                }
            }
        }
        errors.push(Math.abs(sampled / exact - 1));
    }
    results.push({ zoom, widthM, cases: errors.length, meanAbsoluteRelativeError: errors.reduce((a, b) => a + b, 0) / errors.length,
        maxAbsoluteRelativeError: Math.max(...errors) });
}
console.log(JSON.stringify({ method: '600m-rectangles-3-latitudes-12-grid-phases', results }, null, 2));
