import { createHash } from 'node:crypto';
import { DOMParser, type Element as XmlElement } from '@xmldom/xmldom';
import { JSDOM } from 'jsdom';

export const FAA_DTPP_BASE_URL = 'https://aeronav.faa.gov/d-tpp/';
export const PROCEDURE_BUILDER_VERSION = 2;

export type ProcedureKind =
    | 'airport-diagram'
    | 'approach'
    | 'departure'
    | 'arrival'
    | 'takeoff-minimums'
    | 'diverse-vector-area'
    | 'alternate-minimums'
    | 'radar-minimums'
    | 'hot-spot'
    | 'lahso'
    | 'other';

export type ProcedureVolumeTarget = {
    volumeId: string;
    section: string | null;
    printedPage: string | null;
    pageIndex: number | null;
};

export type ProcedureRecord = {
    id: string;
    kind: ProcedureKind;
    name: string;
    sortOrder: number;
    pdfName: string;
    pdfUrl: string;
    namedDestination: string | null;
    volumeTarget: ProcedureVolumeTarget | null;
    source: {
        chartSequence: string;
        chartCode: string;
        userAction: string | null;
        changeNoticeFlag: string | null;
        changeNoticeSection: string | null;
        changeNoticePage: string | null;
        procedureId: string | null;
        twoColored: string | null;
        civil: string | null;
        faaComputerCode: string | null;
        copter: string | null;
        amendmentNumber: string | null;
        amendmentDate: string | null;
        extraFields: Record<string, string>;
    };
};

export type ProcedureAirport = {
    id: string;
    faaId: string;
    icaoId: string | null;
    name: string;
    city: string;
    state: string;
    volumeId: string;
    military: boolean;
    sortCode: string;
    procedures: ProcedureRecord[];
};

export type ProcedureVolume = {
    id: string;
    url: string;
    byteLength: number;
    sha256: string;
    pageCount: number;
    resolvedTargetCount: number;
    unresolvedTargetCount: number;
};

export type ProcedureCatalog = {
    schemaVersion: 1;
    builderVersion: number;
    cycle: string;
    effectiveDate: string;
    expirationDate: string;
    generatedAt: string;
    faaPdfBaseUrl: string;
    sourceXml: {
        url: string;
        sha256: string;
    };
    volumes: ProcedureVolume[];
    airports: ProcedureAirport[];
};

export type IndexedPdfPage = {
    pageIndex: number;
    text: string;
    pageLabels: string[];
};

export type PdfTextItem = {
    text: string;
    x: number;
    y: number;
    width: number;
};

export type PageResolution = {
    resolved: number;
    unresolved: number;
};

export type DtppEdition = {
    cycle: string;
    effectiveDate: string;
    expirationDate: string;
    url: string;
};

export type EffectiveInterval = {
    effectiveDate: string;
    expirationDate: string;
};

const XML_PDF_NAME = /^[A-Z0-9][A-Z0-9_.-]*\.PDF$/i;
const XML_DATE = /\b(\d{2})\/(\d{2})\/(\d{2})\b/;
const EDITION_DATE = /([A-Z]{3})\s+(\d{1,2})\s*[^A-Z0-9]+\s*([A-Z]{3})\s+(\d{1,2}),\s*(\d{4})/i;
const MONTHS = new Map([
    ['Jan', 1], ['Feb', 2], ['Mar', 3], ['Apr', 4], ['May', 5], ['Jun', 6],
    ['Jul', 7], ['Aug', 8], ['Sep', 9], ['Oct', 10], ['Nov', 11], ['Dec', 12]
]);

export function parseProcedureCatalog(
    xmlSource: string,
    sourceUrl: string,
    sourceSha256: string,
    generatedAt = new Date().toISOString()
): ProcedureCatalog {
    const errors: string[] = [];
    const document = new DOMParser({
        onError: (level, message) => {
            if (level !== 'warning') errors.push(message);
        }
    }).parseFromString(xmlSource.replace(/^\uFEFF/, ''), 'text/xml');
    if (errors.length > 0 || document.documentElement.tagName !== 'digital_tpp') {
        throw new Error(`Invalid d-TPP XML${errors[0] ? `: ${errors[0]}` : ''}`);
    }

    const root = document.documentElement;
    const cycle = requiredAttribute(root, 'cycle');
    if (!/^\d{4}$/.test(cycle)) throw new Error(`Invalid d-TPP cycle: ${cycle}`);
    const effectiveDate = parseXmlDate(requiredAttribute(root, 'from_edate'));
    const expirationDate = parseXmlDate(requiredAttribute(root, 'to_edate'));
    if (effectiveDate >= expirationDate) throw new Error('d-TPP effective interval is invalid');

    const airports: ProcedureAirport[] = [];
    const airportIds = new Set<string>();
    const procedureIds = new Set<string>();
    for (const stateElement of childElements(root, 'state_code')) {
        const state = requiredAttribute(stateElement, 'ID');
        for (const cityElement of childElements(stateElement, 'city_name')) {
            const city = requiredAttribute(cityElement, 'ID');
            const volumeId = normalizeVolume(requiredAttribute(cityElement, 'volume'));
            for (const airportElement of childElements(cityElement, 'airport_name')) {
                const faaId = requiredAttribute(airportElement, 'apt_ident').toUpperCase();
                const icaoId = nullable(attribute(airportElement, 'icao_ident'))?.toUpperCase() ?? null;
                const airportId = icaoId || faaId;
                if (airportIds.has(airportId)) {
                    throw new Error(`Duplicate d-TPP airport identifier: ${airportId}`);
                }
                airportIds.add(airportId);

                const activeRecords = childElements(airportElement, 'record').filter(record =>
                    childText(record, 'useraction').toUpperCase() !== 'D' &&
                    !/^(?:DELETED_JOB|DEL_APT_SERVED)\.PDF$/i.test(childText(record, 'pdf_name'))
                );
                const procedures = activeRecords.map(record => {
                    const chartSequence = requiredChildText(record, 'chartseq');
                    const chartCode = requiredChildText(record, 'chart_code').toUpperCase();
                    const name = requiredChildText(record, 'chart_name');
                    const pdfName = requiredChildText(record, 'pdf_name').toUpperCase();
                    if (!XML_PDF_NAME.test(pdfName)) {
                        throw new Error(`Unsafe d-TPP PDF filename: ${pdfName}`);
                    }
                    const id = `${cycle}:${airportId}:${recordFingerprint(record)}`;
                    if (procedureIds.has(id)) throw new Error(`Duplicate d-TPP procedure: ${id}`);
                    procedureIds.add(id);

                    const boundPage = nullable(childText(record, 'bvpage'));
                    const boundSection = nullable(childText(record, 'bvsection'));
                    const namedDestination = needsNamedDestination(chartCode, boundPage)
                        ? `(${faaId})`
                        : null;
                    return {
                        id,
                        kind: procedureKind(chartCode, chartSequence),
                        name,
                        sortOrder: parseChartSequence(chartSequence),
                        pdfName,
                        pdfUrl: new URL(pdfName, `${FAA_DTPP_BASE_URL}${cycle}/`).href,
                        namedDestination,
                        volumeTarget: boundPage || boundSection ? {
                            volumeId,
                            section: boundSection,
                            printedPage: boundPage,
                            pageIndex: null
                        } : null,
                        source: {
                            chartSequence,
                            chartCode,
                            userAction: nullable(childText(record, 'useraction')),
                            changeNoticeFlag: nullable(childText(record, 'cn_flg')),
                            changeNoticeSection: nullable(childText(record, 'cnsection')),
                            changeNoticePage: nullable(childText(record, 'cnpage')),
                            procedureId: nullable(childText(record, 'procuid')),
                            twoColored: nullable(childText(record, 'two_colored')),
                            civil: nullable(childText(record, 'civil')),
                            faaComputerCode: nullable(childText(record, 'faanfd18')),
                            copter: nullable(childText(record, 'copter')),
                            amendmentNumber: nullable(childText(record, 'amdtnum')),
                            amendmentDate: nullable(childText(record, 'amdtdate')),
                            extraFields: extraRecordFields(record)
                        }
                    } satisfies ProcedureRecord;
                });
                procedures.sort(compareProcedures);
                airports.push({
                    id: airportId,
                    faaId,
                    icaoId,
                    name: requiredAttribute(airportElement, 'ID'),
                    city,
                    state,
                    volumeId,
                    military: attribute(airportElement, 'military').toUpperCase() === 'M',
                    sortCode: attribute(airportElement, 'alnum'),
                    procedures
                });
            }
        }
    }
    airports.sort((left, right) => left.id.localeCompare(right.id));

    return {
        schemaVersion: 1,
        builderVersion: PROCEDURE_BUILDER_VERSION,
        cycle,
        effectiveDate,
        expirationDate,
        generatedAt,
        faaPdfBaseUrl: `${FAA_DTPP_BASE_URL}${cycle}/`,
        sourceXml: { url: sourceUrl, sha256: sourceSha256 },
        volumes: [],
        airports
    };
}

export function resolveVolumePageIndexes(
    catalog: ProcedureCatalog,
    volumeId: string,
    pages: IndexedPdfPage[]
): PageResolution {
    const normalizedVolume = normalizeVolume(volumeId);
    const labelPages = new Map<string, number[]>();
    for (const page of pages) {
        for (const token of page.pageLabels.map(normalizePageToken)) {
            if (!/^[A-Z]{0,2}\d{1,4}$/.test(token)) continue;
            const indexes = labelPages.get(token) ?? [];
            if (!indexes.includes(page.pageIndex)) indexes.push(page.pageIndex);
            labelPages.set(token, indexes);
        }
    }

    let resolved = 0;
    let unresolved = 0;
    for (const airport of catalog.airports) {
        if (airport.volumeId !== normalizedVolume) continue;
        for (const procedure of airport.procedures) {
            const target = procedure.volumeTarget;
            if (!target) continue;
            const pageIndex = target.printedPage
                ? uniquePage(labelPages.get(normalizePageToken(
                    `${target.section ?? ''}${target.printedPage}`
                )))
                : findAirportSectionPage(pages, target.section, airport);
            target.pageIndex = pageIndex;
            if (pageIndex === null) unresolved += 1;
            else resolved += 1;
        }
    }
    return { resolved, unresolved };
}

export function pageIndexEntry(
    pageIndex: number,
    textItems: PdfTextItem[],
    pageWidth: number,
    pageHeight: number
): IndexedPdfPage {
    const nonempty = textItems.filter(item => item.text.trim());
    const text = nonempty.map(item => item.text.trim()).join(' ');
    // Pacific's inset charts use a separate, left/right-aligned section header.
    const terminalHeader = nonempty.find(item =>
        item.text.trim() === 'TERMINAL PROCEDURES' && item.y >= pageHeight - 35
    );
    // The Pacific section divider repeats a main-supplement page number.
    if (terminalHeader && /\btable of contents\b/i.test(text)) {
        return { pageIndex, text, pageLabels: [] };
    }
    const edgeItems = nonempty.filter(item => terminalHeader
        ? Math.abs(item.y - terminalHeader.y) <= 0.75
        : item.y <= 20 || item.y >= pageHeight - 20);
    const pageLabels = mergeAdjacentItems(edgeItems).filter(item => {
        const token = normalizePageToken(item.text);
        const centered = Math.abs(item.x + item.width / 2 - pageWidth / 2) <= 12;
        return (terminalHeader || centered) && isPageLabel(token);
    }).map(item => normalizePageToken(item.text));
    return {
        pageIndex,
        text,
        pageLabels: [...new Set(pageLabels)]
    };
}

function mergeAdjacentItems(items: PdfTextItem[]): PdfTextItem[] {
    const sorted = [...items].sort((left, right) => left.y - right.y || left.x - right.x);
    const merged: PdfTextItem[] = [];
    for (const item of sorted) {
        const previous = merged.at(-1);
        const gap = previous ? item.x - previous.x - previous.width : Infinity;
        if (previous && Math.abs(item.y - previous.y) <= 0.75 && gap >= -0.75 && gap <= 2) {
            previous.text += item.text;
            previous.width = Math.max(previous.width, item.x + item.width - previous.x);
        } else {
            merged.push({ ...item });
        }
    }
    return merged;
}

export function discoverDtppEditions(html: string, baseUrl: string): DtppEdition[] {
    const dom = new JSDOM(html, { url: baseUrl });
    const anchors = Array.from(dom.window.document.querySelectorAll('a')) as any[];
    const editions: DtppEdition[] = [];
    for (const anchor of anchors) {
        const url = new URL(String(anchor.getAttribute('href') || ''), baseUrl);
        if (!/d-tpp_Metafile\.xml$/i.test(url.pathname)) continue;
        const range = parseEditionRange(String(anchor.textContent || '').trim());
        const cycle = url.pathname.match(/\/d-tpp\/(\d{4})\//i)?.[1];
        if (!range || !cycle) continue;
        editions.push({ cycle, ...range, url: url.href });
    }
    return editions;
}

export function parseVolumeEffectiveInterval(text: string): EffectiveInterval | null {
    const match = text.match(
        /Effective:?\s*\d{4}Z\s+(\d{1,2})\s+([A-Z]{3})\s+(\d{4})\s+to:?\s*\d{4}Z\s+(\d{1,2})\s+([A-Z]{3})\s+(\d{4})/i
    );
    if (!match) return null;
    const startMonth = MONTHS.get(titleCase(match[2]));
    const endMonth = MONTHS.get(titleCase(match[5]));
    if (!startMonth || !endMonth) return null;
    return {
        effectiveDate: isoDate(Number(match[3]), startMonth, Number(match[1])),
        expirationDate: isoDate(Number(match[6]), endMonth, Number(match[4]))
    };
}

function parseEditionRange(label: string): Pick<DtppEdition, 'effectiveDate' | 'expirationDate'> | null {
    const match = label.match(EDITION_DATE);
    if (!match) return null;
    const startMonth = MONTHS.get(titleCase(match[1]));
    const endMonth = MONTHS.get(titleCase(match[3]));
    if (!startMonth || !endMonth) return null;
    const endYear = Number(match[5]);
    const startYear = startMonth > endMonth ? endYear - 1 : endYear;
    return {
        effectiveDate: isoDate(startYear, startMonth, Number(match[2])),
        expirationDate: isoDate(endYear, endMonth, Number(match[4]))
    };
}

function findAirportSectionPage(
    pages: IndexedPdfPage[],
    section: string | null,
    airport: ProcedureAirport
): number | null {
    if (!section) return null;
    const normalizedSection = section.toUpperCase();
    const identifiers = [airport.faaId, airport.icaoId].filter(Boolean) as string[];
    // Some military headers use a K-prefixed FAA ID that the XML omits.
    if (airport.military && !airport.icaoId && airport.faaId.length === 3) {
        identifiers.push(`K${airport.faaId}`);
    }
    for (const page of pages) {
        if (!page.pageLabels.some(token =>
            normalizePageToken(token).match(new RegExp(`^${escapeRegExp(normalizedSection)}\\d+$`))
        )) continue;
        const compactText = page.text.toUpperCase().replace(/\s+/g, '');
        const parenthesizedIds = compactText.matchAll(/\(([A-Z0-9/]+)\)/g);
        if ([...parenthesizedIds].some(([, ids]) =>
            ids.split('/').some(id => identifiers.includes(id))
        )) {
            return page.pageIndex;
        }
    }
    return null;
}

function procedureKind(chartCode: string, chartSequence: string): ProcedureKind {
    switch (chartCode) {
        case 'APD': return 'airport-diagram';
        case 'IAP': return 'approach';
        case 'DP':
        case 'ODP': return 'departure';
        case 'STR': return 'arrival';
        case 'STAR': return 'arrival';
        case 'HOT': return 'hot-spot';
        case 'LAH': return 'lahso';
        case 'MIN':
            switch (Number(chartSequence)) {
                case 10100: return 'takeoff-minimums';
                case 10110: return 'diverse-vector-area';
                case 10200: return 'alternate-minimums';
                case 10400: return 'radar-minimums';
                default: return 'other';
            }
        default: return 'other';
    }
}

function needsNamedDestination(chartCode: string, boundPage: string | null): boolean {
    return boundPage === null && ['MIN', 'HOT', 'LAH'].includes(chartCode);
}

function compareProcedures(left: ProcedureRecord, right: ProcedureRecord): number {
    return left.sortOrder - right.sortOrder ||
        left.name.localeCompare(right.name) ||
        left.pdfName.localeCompare(right.pdfName);
}

function childElements(parent: XmlElement, tagName: string): XmlElement[] {
    return Array.from(parent.childNodes)
        .filter((node): node is XmlElement =>
            node.nodeType === 1 && (tagName === '*' || node.nodeName === tagName)
        );
}

function requiredChildText(parent: XmlElement, tagName: string): string {
    const value = childText(parent, tagName);
    if (!value) throw new Error(`Missing d-TPP element: ${tagName}`);
    return value;
}

function childText(parent: XmlElement, tagName: string): string {
    return childElements(parent, tagName)[0]?.textContent?.trim() ?? '';
}

function requiredAttribute(element: XmlElement, name: string): string {
    const value = attribute(element, name);
    if (!value) throw new Error(`Missing d-TPP attribute: ${name}`);
    return value;
}

function attribute(element: XmlElement, name: string): string {
    return element.getAttribute(name)?.trim() ?? '';
}

function nullable(value: string): string | null {
    return value || null;
}

function parseXmlDate(value: string): string {
    const match = value.match(XML_DATE);
    if (!match) throw new Error(`Invalid d-TPP date: ${value}`);
    return isoDate(2000 + Number(match[3]), Number(match[1]), Number(match[2]));
}

function isoDate(year: number, month: number, day: number): string {
    const value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
        throw new Error(`Invalid date: ${value}`);
    }
    return value;
}

function parseChartSequence(value: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`Invalid d-TPP chart sequence: ${value}`);
    }
    return parsed;
}

function normalizeVolume(value: string): string {
    const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!normalized) throw new Error(`Invalid d-TPP volume: ${value}`);
    return normalized;
}

function normalizePageToken(value: string): string {
    return value.toUpperCase().replace(/\s+/g, '');
}

function titleCase(value: string): string {
    return value.slice(0, 1).toUpperCase() + value.slice(1).toLowerCase();
}

function isPageLabel(value: string): boolean {
    return /^[A-Z]{0,2}\d{1,4}$/.test(value);
}

function extraRecordFields(record: XmlElement): Record<string, string> {
    const known = new Set([
        'chartseq', 'chart_code', 'chart_name', 'useraction', 'pdf_name', 'cn_flg',
        'cnsection', 'cnpage', 'bvsection', 'bvpage', 'procuid', 'two_colored',
        'civil', 'faanfd18', 'copter', 'amdtnum', 'amdtdate'
    ]);
    return Object.fromEntries(
        childElements(record, '*')
            .filter(element => !known.has(element.tagName))
            .map(element => [element.tagName, element.textContent?.trim() ?? ''])
    );
}

function recordFingerprint(record: XmlElement): string {
    const canonical = childElements(record, '*')
        .map(element => `${element.tagName}=${element.textContent?.trim() ?? ''}`)
        .join('\n');
    return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function uniquePage(indexes: number[] | undefined): number | null {
    return indexes?.length === 1 ? indexes[0] : null;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
