import { DOMParser } from '@xmldom/xmldom';
import type { PdfTextItem } from './procedures.ts';

export const SUPPLEMENT_REGIONS = ['AK', 'EC', 'NC', 'NE', 'NW', 'PAC', 'SC', 'SE', 'SW'] as const;
export const SUPPLEMENT_BUILDER_VERSION = 2;

export type SupplementAirport = {
    faaId: string;
    name: string;
    city: string;
    state: string;
    volumeId: string;
    printedPage: string;
    pageIndex: number;
};

export type SupplementVolume = {
    id: string;
    url: string;
    byteLength: number;
    sha256: string;
    pageCount: number;
};

export type SupplementCatalog = {
    schemaVersion: 2;
    builderVersion: number;
    effectiveDate: string;
    expirationDate: string;
    generatedAt: string;
    sourceXml: { url: string; sha256: string };
    volumes: SupplementVolume[];
    airports: SupplementAirport[];
    expected: Pick<SupplementAirport, 'faaId' | 'state' | 'volumeId' | 'printedPage'>[];
};

export function supplementDate(value: string): string {
    const date = new Date(`${value}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) ||
        date.toISOString().slice(0, 10) !== value) throw new Error(`Invalid date: ${value}`);
    return value;
}

export function supplementDateCode(value: string): string {
    const date = new Date(`${supplementDate(value)}T00:00:00Z`);
    const month = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][date.getUTCMonth()];
    return `${value.slice(8)}${month}${value.slice(0, 4)}`;
}

/** FAA's first numbered PDF is the directory page; later PDFs can be special notices. */
export function parseSupplementIndex(xml: string): Pick<SupplementCatalog, 'effectiveDate' | 'expirationDate'> & {
    airports: Omit<SupplementAirport, 'pageIndex'>[];
} {
    const document = new DOMParser({ onError: level => {
        if (level !== 'warning') throw new Error('Invalid Chart Supplement XML');
    } }).parseFromString(xml, 'application/xml');
    const root = document.documentElement;
    if (root?.tagName !== 'airports') throw new Error('Invalid Chart Supplement XML root');
    const date = (key: string) => {
        const match = root.getAttribute(key)?.match(/^0901Z (\d{2})\/(\d{2})\/(\d{2})$/);
        if (!match) throw new Error(`Invalid Chart Supplement ${key}`);
        return supplementDate(`20${match[3]}-${match[1]}-${match[2]}`);
    };
    const effectiveDate = date('from_edate');
    const expirationDate = date('to_edate');
    if (expirationDate <= effectiveDate) throw new Error('Invalid Chart Supplement effective interval');
    const airports = new Map<string, Omit<SupplementAirport, 'pageIndex'>>();
    for (const location of Array.from(root.getElementsByTagName('location'))) {
        for (const airport of Array.from(location.getElementsByTagName('airport'))) {
            const text = (tag: string) => airport.getElementsByTagName(tag)[0]?.textContent?.trim() ?? '';
            const faaId = text('aptid').toUpperCase();
            if (!faaId) continue; // NAVAID-only entries share this XML schema.
            const name = text('aptname');
            const target = text('pdf').match(/^(AK|EC|NC|NE|NW|PAC|SC|SE|SW)_(\d+)_(\d{2}[A-Z]{3}\d{4})\.pdf$/i);
            if (!name || !/^[A-Z0-9]{1,4}$/.test(faaId) || !target ||
                target[3].toUpperCase() !== supplementDateCode(effectiveDate)) {
                throw new Error(`Invalid Chart Supplement page for ${faaId}`);
            }
            const volumeId = target[1].toUpperCase();
            const printedPage = String(Number(target[2]));
            // Border airports can appear in two regional books. Keep both; collapse
            // duplicate city/state cross-references to the same physical page.
            airports.set(`${faaId}:${volumeId}:${printedPage}`, {
                faaId, name, city: text('aptcity'), state: location.getAttribute('state') ?? '',
                volumeId, printedPage,
            });
        }
    }
    if (!airports.size) throw new Error('Chart Supplement XML has no airports');
    return { effectiveDate, expirationDate, airports: [...airports.values()] };
}

/** Only page numbers in the outer top margin qualify, never numbers in airport text. */
export function supplementPageLabel(items: PdfTextItem[], width: number, height: number): string | undefined {
    const labels = [...new Set(items.filter(item =>
        item.y >= height - 35 && (item.x < 65 || item.x > width - 65) && /^\d{1,4}$/.test(item.text.trim())
    ).map(item => String(Number(item.text.trim()))))];
    return labels.length === 1 ? labels[0] : undefined;
}
