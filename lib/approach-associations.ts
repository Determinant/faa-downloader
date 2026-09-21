import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { approachIdent } from './approach-ident.ts';
import type { ProcedureCatalog } from './procedures.ts';
import type { projectApproachRoutes } from './approach-routes.ts';

type Routes = ReturnType<typeof projectApproachRoutes>;
type Review = { airport: string; title: string; routeId: string; evidence: { plateUrl: string; comparedFixes: string } };
export type ApproachAssociations = {
    schemaVersion: 1; ruleVersion: 1; effectiveDate: string;
    sources: { terminalJsonSha256: string; cifpSha256: string; chartXmlSha256: string; reviewsSha256?: string };
    records: { airport: string; procedureId: string; title: string; routeIds: string[];
        status: 'matched' | 'ambiguous' | 'unmatched'; rule: 'canonical' | 'reviewed' | 'parallel-equivalent' | 'parallel-choice' | 'unmatched';
        evidence?: Review['evidence'] }[];
};
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const title = (text: string) => text.trim().toUpperCase().replace(/\s+/g, ' ').replace(/, CONT\.\d+$/, '');

export function associateApproachCharts(catalog: ProcedureCatalog, routes: Routes,
    sources: ApproachAssociations['sources'], reviews: readonly Review[] = []): ApproachAssociations {
    if (catalog.effectiveDate !== routes.metadata.effectiveDate || sources.chartXmlSha256 !== catalog.sourceXml.sha256) {
        throw new Error('Chart associations require matching editions and source identities');
    }
    const byAirport = new Map<string, Routes['procedures']>();
    for (const p of routes.procedures) {
        const entries = byAirport.get(p.airport) ?? [];
        entries.push(p); byAirport.set(p.airport, entries);
    }
    const records: ApproachAssociations['records'] = [];
    for (const airport of catalog.airports) for (const chart of airport.procedures) {
        if (chart.kind !== 'approach' || chart.source.userAction === 'D') continue;
        const code = airport.icaoId || airport.faaId, name = title(chart.name);
        const candidates = byAirport.get(code) ?? [];
        const matching = (ident: string | undefined) => ident ? candidates.filter(p => p.ident === ident) : [];
        let matches = matching(approachIdent(name));
        let rule: ApproachAssociations['records'][number]['rule'] = matches.length ? 'canonical' : 'unmatched';
        let evidence: Review['evidence'] | undefined;
        if (!matches.length) {
            const review = reviews.find(r => r.airport === code && r.title === name);
            const reviewed = review && candidates.filter(p => p.id === review.routeId);
            if (reviewed?.length === 1 && review!.evidence.plateUrl.toUpperCase() === chart.pdfUrl.toUpperCase()) {
                matches = reviewed; rule = 'reviewed'; evidence = review!.evidence;
            }
        }
        const parallel = /^(.* RWY \d{2})([LCR])\/([LCR])$/.exec(name);
        if (!matches.length && parallel && parallel[2] !== parallel[3]) {
            const first = matching(approachIdent(parallel[1] + parallel[2])), second = matching(approachIdent(parallel[1] + parallel[3]));
            if (first.length === 1 && second.length === 1) {
                const a = first[0], b = second[0];
                const equivalent = a.magneticVariation === b.magneticVariation &&
                    JSON.stringify(a.transitions) === JSON.stringify(b.transitions) && JSON.stringify(a.final) === JSON.stringify(b.final);
                matches = equivalent ? first : [...first, ...second];
                rule = equivalent ? 'parallel-equivalent' : 'parallel-choice';
            }
        }
        records.push({ airport: code, procedureId: chart.id, title: chart.name,
            routeIds: matches.map(p => p.id), status: matches.length === 0 ? 'unmatched' : matches.length === 1 ? 'matched' : 'ambiguous',
            rule, ...(evidence ? { evidence } : {}) });
    }
    return { schemaVersion: 1, ruleVersion: 1, effectiveDate: catalog.effectiveDate, sources, records };
}

/** A standalone plate build may precede navigation publication. A subsequent
 * incremental build joins the exact navigation generation without reindexing PDFs. */
export async function publishedApproachAssociations(catalog: ProcedureCatalog, navDirectory: string): Promise<ApproachAssociations | undefined> {
    let manifest;
    try { manifest = JSON.parse(await fs.readFile(path.join(navDirectory, 'manifest.json'), 'utf8')); }
    catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
    if (manifest.schemaVersion !== 2) return;
    const product = manifest.products?.find(p => p.id === 'terminal-procedures');
    if (manifest.effectiveDate !== catalog.effectiveDate || !product || !/^terminal-procedures\.[a-f0-9]{64}\.json$/.test(product.file)) {
        throw new Error('Invalid navigation generation for chart associations');
    }
    const bytes = await fs.readFile(path.join(navDirectory, product.file)), terminal = JSON.parse(bytes.toString('utf8'));
    if (hash(bytes) !== product.sha256 || hash(JSON.stringify(terminal)) !== product.jsonSha256 ||
        terminal.metadata.effectiveDate !== catalog.effectiveDate) throw new Error('Navigation identity mismatch for chart associations');
    let reviewed: { effectiveDate: string; sources: { cifpSha256: string; chartXmlSha256: string }; entries: Review[] } | undefined, reviewsSha256: string | undefined;
    try {
        const bytes = await fs.readFile(new URL(`../data/approach-associations/${catalog.effectiveDate}.json`, import.meta.url));
        reviewed = JSON.parse(bytes.toString('utf8')); reviewsSha256 = hash(bytes);
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    if (reviewed && reviewed.effectiveDate !== catalog.effectiveDate) throw new Error('Reviewed chart associations belong to another edition');
    const cifpSha256 = terminal.sources?.find(s => s.group === 'CIFP')?.recordFile.sha256;
    if (!/^[a-f0-9]{64}$/.test(cifpSha256 ?? '')) throw new Error('Missing CIFP identity for chart associations');
    if (reviewed && (reviewed.sources.cifpSha256 !== cifpSha256 || reviewed.sources.chartXmlSha256 !== catalog.sourceXml.sha256)) {
        throw new Error('Reviewed chart associations require another source comparison before publication');
    }
    return associateApproachCharts(catalog, terminal.approaches, { terminalJsonSha256: product.jsonSha256,
        cifpSha256, chartXmlSha256: catalog.sourceXml.sha256, ...(reviewsSha256 ? { reviewsSha256 } : {}) }, reviewed?.entries);
}
