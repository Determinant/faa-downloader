import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

const MODEL = 'WMM-2025';
const EPOCH = 2025;
const MAX_DEGREE = 12;
const COEFFICIENT_SHA256 = 'dfa8597825af4e0b87ff4198a5b4fb661b3c49f4cd090cd0164e0259b075582f';
const COEFFICIENT_FILE = new URL('../data/WMM2025.COF', import.meta.url);

export type MagneticCoefficient = [n: number, m: number, g: number, h: number, gDot: number, hDot: number];

/** Preserve NOAA's Schmidt semi-normalized coefficients and secular variation.
 * This exports the global model; clients evaluate it at their position and date.
 * No interpolation grid or VOR station alignment enters this product. */
export function parseMagneticCoefficients(source: string): MagneticCoefficient[] {
    const lines = source.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const [epoch, name, releaseDate, ...extra] = (lines.shift() ?? '').split(/\s+/);
    if (Number(epoch) !== EPOCH || name !== MODEL || releaseDate !== '11/13/2024' || extra.length) {
        throw new Error(`Expected the published ${MODEL} coefficient header`);
    }
    const coefficients: MagneticCoefficient[] = [];
    for (let n = 1; n <= MAX_DEGREE; n += 1) {
        for (let m = 0; m <= n; m += 1) {
            const fields = (lines.shift() ?? '').split(/\s+/);
            if (fields.length !== 6 || fields.some(field => !/^-?\d+(?:\.\d+)?$/.test(field))) {
                throw new Error(`Invalid ${MODEL} coefficient at degree ${n}, order ${m}`);
            }
            const row = fields.map(Number) as MagneticCoefficient;
            if (!row.every(Number.isFinite) || row[0] !== n || row[1] !== m ||
                (m === 0 && (row[3] !== 0 || row[5] !== 0))) {
                throw new Error(`Invalid ${MODEL} coefficient at degree ${n}, order ${m}`);
            }
            coefficients.push(row);
        }
    }
    if (!lines.length || lines.some(line => !/^9{4,}$/.test(line))) {
        throw new Error(`Invalid ${MODEL} coefficient terminator`);
    }
    return coefficients;
}

/** The tiny authoritative input is pinned in the repository, so both online and
 * --source-dir builds produce identical model data without another download. */
export async function buildMagneticModel(effectiveDate: string) {
    const source = await fs.readFile(COEFFICIENT_FILE);
    const sha256 = createHash('sha256').update(source).digest('hex');
    if (sha256 !== COEFFICIENT_SHA256) throw new Error(`${MODEL} coefficient checksum mismatch`);
    const coefficients = parseMagneticCoefficients(source.toString('utf8'));
    return {
        type: 'ZLayerMagneticModel',
        schemaVersion: 1,
        effectiveDate,
        model: MODEL,
        epoch: EPOCH,
        // Model validity is independent of the FAA edition and build date.
        validFrom: '2025-01-01',
        validUntil: '2030-01-01', // Exclusive.
        maxDegree: MAX_DEGREE,
        coverage: 'global',
        coordinateSystem: 'WGS84',
        altitudeReference: 'ellipsoid',
        referenceRadiusKm: 6371.2,
        normalization: 'schmidt-semi-normalized',
        coefficientFields: ['n', 'm', 'g', 'h', 'gDot', 'hDot'],
        coefficientUnits: 'nT',
        secularVariationUnits: 'nT/year',
        declinationConvention: 'east-positive',
        source: {
            name: 'NOAA NCEI / British Geological Survey',
            url: 'https://www.ncei.noaa.gov/products/world-magnetic-model',
            downloadUrl: 'https://www.ncei.noaa.gov/sites/default/files/2024-12/WMM2025COF.zip',
            filename: 'WMM2025.COF',
            sha256
        },
        coefficients
    };
}
