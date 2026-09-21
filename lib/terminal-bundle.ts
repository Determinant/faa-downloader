import { buildTerminalProcedures, type TerminalProcedureInput } from './terminal-procedures.ts';
import { parseCifpProcedures, CIFP_SOURCE } from './cifp.ts';
import { projectApproachRoutes } from './approach-routes.ts';
import type { CifpSource } from './cifp-source.ts';

/** Assemble one complete edition. Charts are a separate product; their presence
 * does not establish coded procedure coverage. No optional approach build path. */
export function buildTerminalBundle(input: TerminalProcedureInput, cifpInput: string, effectiveDate: string, source: CifpSource) {
    const topology = buildTerminalProcedures(input, effectiveDate);
    const cifp = parseCifpProcedures(cifpInput, effectiveDate);
    for (const kind of ['departure', 'arrival', 'approach'] as const) {
        if (!cifp.sourceRecords[kind]) throw new Error(`CIFP contains no ${kind} records; terminal bundle is incomplete`);
    }
    for (const kind of ['departure', 'arrival'] as const) {
        if (!topology.procedures.some(p => p.kind === kind && p.routes.length)) {
            throw new Error(`NASR contains no ${kind} route topology; terminal bundle is incomplete`);
        }
    }
    const approaches = projectApproachRoutes(cifp);
    if (cifp.exportedContinuations !== cifp.continuationRecords) throw new Error('CIFP continuation records were lost during export');
    const coded = cifp.procedures.filter(procedure => procedure.kind !== 'approach');
    const exportedLegs = { departure: 0, arrival: 0, approach: 0 };
    for (const procedure of coded) for (const branch of procedure.branches) exportedLegs[procedure.kind] += branch.legs.length;
    for (const procedure of approaches.procedures) {
        exportedLegs.approach += procedure.final.length;
        for (const transition of procedure.transitions) exportedLegs.approach += transition.legs.length;
    }
    for (const procedure of approaches.unavailable) for (const branch of procedure.branches) exportedLegs.approach += branch.legs.length;
    for (const kind of ['departure', 'arrival', 'approach'] as const) {
        if (exportedLegs[kind] !== cifp.sourceRecords[kind]) throw new Error(`CIFP ${kind} records were lost during export`);
    }
    const coverage = {
        departures: topology.procedures.filter(p => p.kind === 'departure').length,
        arrivals: topology.procedures.filter(p => p.kind === 'arrival').length,
        approaches: approaches.procedures.length,
        unavailableApproaches: approaches.unavailable.length,
        codedDepartures: coded.filter(p => p.kind === 'departure').length,
        codedArrivals: coded.filter(p => p.kind === 'arrival').length,
        sourceLegs: cifp.sourceRecords,
        exportedLegs,
        continuationRecords: cifp.continuationRecords,
        exportedContinuations: cifp.exportedContinuations,
        unresolvedReferences: cifp.diagnostics.length
    };
    // NASR BASE, APT and RTE rows must either reach the filing projection or
    // appear in the explicit uncoded ledger. A successful join cannot lose rows.
    for (const [group, kind] of [['DP', 'departure'], ['STAR', 'arrival']] as const) {
        const procedures = topology.procedures.filter(p => p.kind === kind);
        const exported = { BASE: procedures.length,
            APT: procedures.flatMap(p => p.routes).reduce((n, r) => n + r.airports.length, 0),
            RTE: procedures.flatMap(p => p.routes).reduce((n, r) => n + r.points.length, 0) };
        for (const table of ['BASE', 'APT', 'RTE'] as const) {
            const excluded = topology.excluded.filter(row => row.group === group && row.table === table).length;
            if (exported[table] + excluded !== topology.sourceRows[`${group}_${table}`]) {
                throw new Error(`NASR ${group}_${table} rows were lost or duplicated during export`);
            }
        }
    }
    return { ...topology, metadata: { ...topology.metadata, source: 'FAA NASR DP/STAR and CIFP', schemaVersion: 2 as const },
        approaches,
        // NASR filing topology remains compatible. ARINC branches are explicit,
        // airport-scoped data, not inferred links between unrelated NASR records.
        codedProcedures: { type: 'ZLayerCodedTerminalProcedures' as const,
            metadata: { effectiveDate, source: CIFP_SOURCE, schemaVersion: 1 as const }, procedures: coded },
        coverage, sources: [source], diagnostics: { topology: topology.diagnostics, cifp: cifp.diagnostics } };
}
