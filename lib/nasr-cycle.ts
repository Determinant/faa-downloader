const DAY_MS = 86_400_000;
const MAJOR_CYCLE_EPOCH = Date.UTC(2026, 8, 3);
const ENROUTE_GROUPS = new Set(['AWY', 'PFR', 'DP', 'STAR']);

/** CSV_README.pdf in FAA's CSV archives specifies a 56-day cadence for these
 * enroute groups. Change notices retain the previous major cycle's rows:
 * https://nfdc.faa.gov/webContent/28DaySub/2026-10-01/README.txt
 */
export function nasrGroupEffectiveDate(cycle: string, group: string): string {
    const date = Date.parse(`${cycle}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cycle) || !Number.isFinite(date) ||
        new Date(date).toISOString().slice(0, 10) !== cycle ||
        (date - MAJOR_CYCLE_EPOCH) % (28 * DAY_MS) !== 0) {
        throw new Error(`Unexpected NASR effective date: ${cycle}`);
    }
    if (!ENROUTE_GROUPS.has(group)) return cycle;
    const period = 56 * DAY_MS;
    const major = MAJOR_CYCLE_EPOCH + Math.floor((date - MAJOR_CYCLE_EPOCH) / period) * period;
    return new Date(major).toISOString().slice(0, 10);
}
