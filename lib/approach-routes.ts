import { CIFP_SOURCE, parseCifpProcedures, type CodedLeg } from './cifp.ts';

type Approach = { id: string; airport: string; ident: string; magneticVariation?: number;
    transitions: { id: string; legs: CodedLeg[] }[]; final: CodedLeg[] };
type Unavailable = Pick<Approach, 'id' | 'airport' | 'ident'> & {
    reason: 'multiple-main-branches' | 'missing-main-branch';
    branches: { id: string; legs: CodedLeg[] }[];
};

/** Client projection of the shared CIFP model. Every source branch is accounted for. */
export function projectApproachRoutes(cifp: ReturnType<typeof parseCifpProcedures>) {
    const procedures: Approach[] = [], unavailable: Unavailable[] = [];
    for (const procedure of cifp.procedures.filter(p => p.kind === 'approach')) {
        const { id, airport, ident, magneticVariation } = procedure;
        const finals = procedure.branches.filter(branch => branch.routeType !== 'A');
        if (finals.length !== 1) {
            unavailable.push({ id, airport, ident, reason: finals.length ? 'multiple-main-branches' : 'missing-main-branch',
                branches: procedure.branches.map(({ id, legs }) => ({ id, legs })) });
        } else {
            procedures.push({ id, airport, ident, ...(magneticVariation !== undefined ? { magneticVariation } : {}),
                transitions: procedure.branches.filter(branch => branch.routeType === 'A')
                    .map(branch => ({ id: branch.transition, legs: branch.legs })), final: finals[0].legs });
        }
    }
    if (!procedures.length) throw new Error('CIFP contains no approach routes');
    return { type: 'ZLayerApproachRoutes' as const,
        metadata: { effectiveDate: cifp.effectiveDate, source: CIFP_SOURCE, schemaVersion: 2 as const },
        procedures, unavailable };
}

export function buildApproachRoutes(input: string, effectiveDate: string) {
    return projectApproachRoutes(parseCifpProcedures(input, effectiveDate));
}
