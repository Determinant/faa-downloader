import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import test from 'node:test';
import { buildMagneticModel, parseMagneticCoefficients } from '../lib/magnetic-model.ts';

const coefficientFile = new URL('../data/WMM2025.COF', import.meta.url);

test('magnetic export preserves the complete published NOAA WMM2025 coefficients and provenance', async () => {
    const source = await fs.readFile(coefficientFile);
    // Published WMM2025.COF from NOAA's December 2024 coefficient archive.
    assert.equal(createHash('sha256').update(source).digest('hex'),
        'dfa8597825af4e0b87ff4198a5b4fb661b3c49f4cd090cd0164e0259b075582f');
    const model = await buildMagneticModel('2026-09-03');
    assert.equal(model.type, 'ZLayerMagneticModel');
    assert.equal(model.schemaVersion, 1);
    assert.equal(model.model, 'WMM-2025');
    assert.equal(model.epoch, 2025);
    assert.equal(model.maxDegree, 12);
    assert.equal(model.coefficients.length, 90);
    assert.deepEqual(model.coefficientFields, ['n', 'm', 'g', 'h', 'gDot', 'hDot']);
    assert.deepEqual(model.coefficients[0], [1, 0, -29351.8, 0, 12, 0]);
    assert.deepEqual(model.coefficients[1], [1, 1, -1410.8, 4545.4, 9.7, -21.5]);
    assert.deepEqual(model.coefficients.at(-1), [12, 12, -.7, .2, -.1, -.1]);
    assert.equal(model.source.sha256, createHash('sha256').update(source).digest('hex'));
    assert.equal(model.source.filename, 'WMM2025.COF');
    assert.equal(model.normalization, 'schmidt-semi-normalized');
    assert.equal(model.declinationConvention, 'east-positive');
    assert.equal(model.coordinateSystem, 'WGS84');
    assert.equal(model.altitudeReference, 'ellipsoid');
    assert.equal(model.coefficientUnits, 'nT');
    assert.equal(model.secularVariationUnits, 'nT/year');
    // The exported array retains every main-field and annual-change term.
    const originalRows = source.toString().trim().split('\n').slice(1, 91)
        .map(line => line.trim().split(/\s+/).map(Number));
    assert.deepEqual(model.coefficients, originalRows);
    assert.deepEqual(parseMagneticCoefficients(source.toString().replaceAll('\n', '\r\n')), originalRows);
});

test('a newer chart edition never extends the magnetic model validity', async () => {
    const original = await buildMagneticModel('2026-09-03');
    const newer = await buildMagneticModel('2030-01-24');
    assert.equal(original.validFrom, '2025-01-01');
    assert.equal(original.validUntil, '2030-01-01');
    assert.deepEqual(newer, { ...original, effectiveDate: '2030-01-24' });
});

test('coefficient parser rejects wrong models, incomplete or ambiguous terms, and malformed numbers', async () => {
    const source = await fs.readFile(coefficientFile, 'utf8');
    const lines = source.trimEnd().split('\n');
    const malformed = [
        source.replace('2025.0', '2020.0'),
        source.replace('WMM-2025', 'WMMHR-2025'),
        source.replace('11/13/2024', '01/01/2020'),
        source.replace('-29351.8', 'NaN'),
        source.replace('-29351.8', 'Infinity'),
        source.replace('-29351.8', '0x1234'),
        source.replace('-29351.8', '1e999'),
        [...lines.slice(0, 1), ...lines.slice(2)].join('\n'), // Missing term.
        [lines[0], lines[1], lines[1], ...lines.slice(3)].join('\n'), // Duplicate.
        [lines[0], lines[2], lines[1], ...lines.slice(3)].join('\n'), // Wrong order.
        source.replace(/1  0  -29351.8\s+0.0/, '1  0  -29351.8  1.0'), // Invalid zonal h.
        lines.slice(0, 91).join('\n'), // Missing terminator.
        source + '13 0 1 0 0 0\n' // Unexpected degree after terminator.
    ];
    for (const input of malformed) {
        assert.throws(() => parseMagneticCoefficients(input), /WMM-2025 coefficient/);
    }
});
