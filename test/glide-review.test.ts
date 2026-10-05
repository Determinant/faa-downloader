import test from 'node:test';
import assert from 'node:assert/strict';
import { previewFeature } from '../lib/glide-preview.ts';
import { reviewGlideFeatures } from '../lib/glide-review.ts';
import type { GlideLandingArea } from '../lib/glide-model.ts';

test('review groups duplicate patches and separates contextual counts from actual landing options', () => {
    const area: GlideLandingArea = [[-98000000, 25000000, -97998000, 25000000, 60, 600, 100, 1],
        [[-98001000, 24999000, 4000, 0, 0, 2000, -4000, 0],
            [-98000500, 24999500, 1000, 0, 0, 1000, -1000, 0]], 256];
    const features = [previewFeature(area, 'a'), previewFeature(area, 'b')];
    const report = reviewGlideFeatures(features, { id: 'fixture', title: 'Fixture', bounds: [-98.01, 24.99, -97.99, 25.01],
        contexts: [{ label: 'Review window', bounds: [-98.01, 24.99, -97.99, 25.01] }],
        probes: [{ label: 'Hole', coordinate: [-98, 25], expected: 'excluded' },
            { label: 'Surface', coordinate: [-97.998, 25], expected: 'review' }] });
    assert.equal(report.patches, 2); assert.equal(report.spatialGroupsWithin1Nm, 1);
    assert.equal(report.reviewContexts[0].patchesWithFitCenterInside, 2);
    assert.deepEqual(report.probes[0].candidateIds, []);
    assert.deepEqual(report.probes[1].candidateIds, ['a', 'b']);
    assert.equal(report.flags[256], 2);
    assert.equal(reviewGlideFeatures([], { id: 'empty', title: 'Empty', bounds: [-98, 25, -97.99, 25.01] }).geographicGapSample.furthestNm, null);
});
