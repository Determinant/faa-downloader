/** FAA Chart Users' Guide: edition changeover is 0901Z, not UTC midnight.
 * https://aeronav.faa.gov/user_guide/cug-complete_20260122.pdf
 * Explicit historical `today` inputs remain edition-date cutoffs for local builds.
 */
export function faaEffectiveDate(now = new Date()): string {
    return new Date(now.getTime() - (9 * 60 + 1) * 60_000).toISOString().slice(0, 10);
}

const AIRAC_EPOCH = Date.UTC(2020, 0, 2);
const AIRAC_PERIOD_MS = 28 * 86_400_000;

/** The 28-day AIRAC schedule is independent of when FAA web pages roll over.
 * https://www.faa.gov/air_traffic/publications/atpubs/aip_html/part1_gen_section_0.1.html
 * Input is an edition-date cutoff, already adjusted by faaEffectiveDate for live builds.
 */
export function airacCycleForDate(value: string): {
    cycle: string; effectiveDate: string; expirationDate: string;
} {
    const date = Date.parse(`${value}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date) ||
        new Date(date).toISOString().slice(0, 10) !== value) {
        throw new Error(`Invalid AIRAC date: ${value}`);
    }
    const start = AIRAC_EPOCH + Math.floor((date - AIRAC_EPOCH) / AIRAC_PERIOD_MS) * AIRAC_PERIOD_MS;
    const year = new Date(start).getUTCFullYear();
    // FAA XML uses two-digit years interpreted as 20xx.
    if (year < 2000 || year > 2099) throw new Error(`Unsupported AIRAC year: ${year}`);
    const first = AIRAC_EPOCH + Math.ceil((Date.UTC(year, 0, 1) - AIRAC_EPOCH) / AIRAC_PERIOD_MS) * AIRAC_PERIOD_MS;
    const number = (start - first) / AIRAC_PERIOD_MS + 1;
    return {
        cycle: String(year).slice(-2) + String(number).padStart(2, '0'),
        effectiveDate: new Date(start).toISOString().slice(0, 10),
        expirationDate: new Date(start + AIRAC_PERIOD_MS).toISOString().slice(0, 10)
    };
}
