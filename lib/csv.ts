export type CsvRecord = Record<string, string>;

export function parseCsvRows(source: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;

    for (let index = source.charCodeAt(0) === 0xfeff ? 1 : 0; index < source.length; index += 1) {
        const character = source[index];

        if (quoted) {
            if (character === '"') {
                if (source[index + 1] === '"') {
                    field += '"';
                    index += 1;
                } else {
                    quoted = false;
                }
            } else {
                field += character;
            }
            continue;
        }

        if (character === '"' && field.length === 0) {
            quoted = true;
        } else if (character === ',') {
            row.push(field);
            field = '';
        } else if (character === '\n') {
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
        } else if (character !== '\r') {
            field += character;
        }
    }

    if (quoted) throw new Error('CSV input ends inside a quoted field');
    if (field.length > 0 || row.length > 0) {
        row.push(field);
        rows.push(row);
    }

    return rows.filter(candidate => candidate.some(value => value.length > 0));
}

export function parseCsvRecords(source: string, label = 'CSV input', requiredHeaders: readonly string[] = []): CsvRecord[] {
    const rows = parseCsvRows(source);
    if (rows.length === 0) throw new Error(`${label} is empty`);

    const headers = rows[0].map(value => value.trim());
    if (headers.some(value => !value)) throw new Error(`${label} contains an empty header`);
    if (new Set(headers).size !== headers.length) throw new Error(`${label} contains duplicate headers`);
    const missing = requiredHeaders.filter(header => !headers.includes(header));
    if (missing.length) throw new Error(`${label} is missing ${missing.join(', ')}`);

    return rows.slice(1).map((values, index) => {
        if (values.length !== headers.length) {
            throw new Error(
                `${label} row ${index + 2} has ${values.length} fields; expected ${headers.length}`
            );
        }
        return Object.fromEntries(headers.map((header, column) => [header, values[column]]));
    });
}
