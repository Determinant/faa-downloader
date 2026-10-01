import assert from 'node:assert/strict';
import test from 'node:test';
import { airacCycleForDate, faaEffectiveDate } from '../lib/faa-effective-date.ts';
import { discoverCurrentNasrCycle } from '../download-nasr.ts';

test('online edition selection changes at 0901 UTC, including year boundaries', () => {
    const index = '<a href="/NASR_Subscription/2026-09-03/">old</a><a href="/NASR_Subscription/2026-10-01/">new</a>';
    for (const [instant, expected] of [
        ['2026-10-01T00:00:00Z', '2026-09-03'],
        ['2026-10-01T09:00:59.999Z', '2026-09-03'],
        ['2026-10-01T09:01:00Z', '2026-10-01'],
    ]) assert.equal(discoverCurrentNasrCycle(index, 'https://example.test', faaEffectiveDate(new Date(instant))).cycle, expected);
    assert.equal(faaEffectiveDate(new Date('2027-01-01T08:00:00Z')), '2026-12-31');
});

test('AIRAC numbering follows the 28-day schedule across leap days and year boundaries', () => {
    for (const [date, cycle, effectiveDate, expirationDate] of [
        ['2026-09-30', '2609', '2026-09-03', '2026-10-01'],
        ['2026-10-01', '2610', '2026-10-01', '2026-10-29'],
        ['2026-10-29', '2611', '2026-10-29', '2026-11-26'],
        ['2027-01-01', '2613', '2026-12-24', '2027-01-21'],
        ['2027-01-21', '2701', '2027-01-21', '2027-02-18'],
        ['2020-01-01', '1913', '2019-12-05', '2020-01-02'],
        ['2020-01-02', '2001', '2020-01-02', '2020-01-30'],
        ['2020-12-31', '2014', '2020-12-31', '2021-01-28'],
        ['2021-01-01', '2014', '2020-12-31', '2021-01-28'],
        ['2021-01-28', '2101', '2021-01-28', '2021-02-25'],
        ['2024-02-29', '2402', '2024-02-22', '2024-03-21']
    ]) assert.deepEqual(airacCycleForDate(date), { cycle, effectiveDate, expirationDate }, date);
});

test('AIRAC cutoffs reject invalid dates and unsupported two-digit years', () => {
    for (const date of ['', '2026-2-03', '2026-02-30', '2026-09-31', '2026-10-01T09:01:00Z', '1999-12-30', '2100-02-01']) {
        assert.throws(() => airacCycleForDate(date), /AIRAC/, date);
    }
});

test('NASR rejects a stale or premature listing instead of mixing navigation and procedure editions', () => {
    const base = 'https://www.faa.gov/NASR_Subscription/';
    for (const html of [
        '<a href="2026-08-06/">Archive</a><a href="2026-10-01/">Next</a>',
        '<a href="2026-09-04/">Invalid edition date</a>',
        '<a href="2026-10-01/">Current</a>'
    ]) {
        assert.throws(() => discoverCurrentNasrCycle(html, base, '2026-09-30'), /expected 2026-09-03/);
    }
});
