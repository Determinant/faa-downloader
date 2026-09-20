import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { parseCsvRows, type CsvRecord } from './csv.ts';

const REQUIRED_COLUMNS = [
    'OAS', 'VERIFIED STATUS', 'COUNTRY', 'STATE', 'CITY', 'LATDEC', 'LONDEC',
    'DMSLAT', 'DMSLON', 'TYPE', 'QUANTITY', 'AGL', 'AMSL', 'LIGHTING', 'ACCURACY',
    'MARKING', 'FAA STUDY', 'ACTION', 'JDATE'
];

function checked(value: string, pattern: RegExp, field: string): string {
    if (!pattern.test(value)) throw new Error(`Invalid ${field}: ${JSON.stringify(value)}`);
    return value;
}

function numeric(value: string, field: string, min: number, max: number, integer = false): number {
    checked(value, integer ? /^-?\d+$/ : /^-?\d+(?:\.\d+)?$/, field);
    const number = Number(value);
    if (!Number.isFinite(number) || number < min || number > max
        || (integer && !Number.isSafeInteger(number))) {
        throw new Error(`Invalid ${field}: ${JSON.stringify(value)}`);
    }
    return number;
}

function actionDate(value: string): string {
    checked(value, /^\d{7}$/, 'JDATE');
    const year = Number(value.slice(0, 4));
    const day = Number(value.slice(4));
    const date = new Date(Date.UTC(year, 0, day));
    if (year < 1000 || day < 1 || date.getUTCFullYear() !== year) {
        throw new Error(`Invalid JDATE: ${JSON.stringify(value)}`);
    }
    return date.toISOString().slice(0, 10);
}

function obstacleFeature(row: CsvRecord) {
    const accuracy = checked(row.ACCURACY, /^(?:[1-9][A-I])?$/, 'ACCURACY');
    return {
        type: 'Feature' as const,
        id: checked(row.OAS, /^[A-Z0-9]{2}-[A-Z0-9]{6}$/, 'OAS'),
        geometry: {
            type: 'Point' as const,
            coordinates: [numeric(row.LONDEC, 'LONDEC', -180, 180), numeric(row.LATDEC, 'LATDEC', -90, 90)]
        },
        properties: {
            verified: checked(row['VERIFIED STATUS'], /^[OU]$/, 'VERIFIED STATUS') === 'O',
            country: checked(row.COUNTRY, /^[A-Z]{2}$/, 'COUNTRY'),
            state: checked(row.STATE, /^(?:[A-Z]{2})?$/, 'STATE') || null,
            city: row.CITY || null,
            structureType: checked(row.TYPE, /\S/, 'TYPE'),
            quantity: numeric(row.QUANTITY, 'QUANTITY', 1, 9, true),
            heightAglFt: numeric(row.AGL, 'AGL', 0, 99999, true),
            elevationMslFt: numeric(row.AMSL, 'AMSL', -99999, 99999, true),
            lightingCode: checked(row.LIGHTING, /^[RDHMSFCWLNU]$/, 'LIGHTING'),
            markingCode: checked(row.MARKING, /^[PWMFSNU]$/, 'MARKING'),
            horizontalAccuracyCode: accuracy[0] || null,
            verticalAccuracyCode: accuracy[1] || null,
            faaStudyNumber: row['FAA STUDY'] || null,
            actionCode: checked(row.ACTION, /^[AC]$/, 'ACTION'),
            actionDate: actionDate(row.JDATE)
        }
    };
}

async function* sourceLines(file: string) {
    // FAA's CSV contains Windows-1252 text (including smart punctuation), one
    // obstacle per physical line. Decode without loading the national file.
    const decoder = new TextDecoder('windows-1252');
    let pending = '';
    for await (const chunk of createReadStream(file)) {
        const lines = (pending + decoder.decode(chunk)).split('\n');
        pending = lines.pop()!;
        for (const line of lines) yield line.replace(/\r$/, '');
    }
    if (pending) yield pending.replace(/\r$/, '');
}

async function* readObstacles(file: string) {
    let headers: string[];
    let lineNumber = 0;
    const ids = new Set<string>();
    for await (const line of sourceLines(file)) {
        lineNumber++;
        if (!line.trim()) continue;
        try {
            const [values] = parseCsvRows(line);
            // The shared parser drops all-empty rows. Only blank lines may be
            // skipped here; a nonblank CSV record must represent an obstacle.
            if (!values) throw new Error('Empty CSV record');
            if (!headers) {
                headers = values.map(value => value.trim());
                if (headers.some(value => !value) || new Set(headers).size !== headers.length) {
                    throw new Error('Empty or duplicate CSV headers');
                }
                const missing = REQUIRED_COLUMNS.filter(column => !headers.includes(column));
                if (missing.length) throw new Error(`Missing CSV columns: ${missing.join(', ')}`);
                continue;
            }
            if (values.length !== headers.length) {
                throw new Error(`CSV row has ${values.length} fields; expected ${headers.length}`);
            }
            const row = Object.fromEntries(headers.map((header, index) => [header, values[index].trim()]));
            const feature = obstacleFeature(row);
            if (ids.has(feature.id)) throw new Error(`Duplicate OAS: ${feature.id}`);
            ids.add(feature.id);
            yield feature;
        } catch (error) {
            throw new Error(`DOF.CSV line ${lineNumber}: ${error.message}`, { cause: error });
        }
    }
    if (!ids.size) throw new Error('DOF.CSV contains no obstacles');
}

export async function writeObstacleGeoJson(sourceFile: string, destination: string) {
    const stats = { count: 0, verifiedCount: 0, unverifiedCount: 0,
        bbox: [Infinity, Infinity, -Infinity, -Infinity], uncompressedBytes: 0 };
    async function* jsonChunks() {
        let buffer = '{"type":"FeatureCollection","features":[';
        for await (const feature of readObstacles(sourceFile)) {
            buffer += `${stats.count ? ',' : ''}${JSON.stringify(feature)}`;
            stats.count++;
            if (feature.properties.verified) stats.verifiedCount++;
            else stats.unverifiedCount++;
            const [lon, lat] = feature.geometry.coordinates;
            stats.bbox[0] = Math.min(stats.bbox[0], lon);
            stats.bbox[1] = Math.min(stats.bbox[1], lat);
            stats.bbox[2] = Math.max(stats.bbox[2], lon);
            stats.bbox[3] = Math.max(stats.bbox[3], lat);
            if (buffer.length >= 64 * 1024) {
                stats.uncompressedBytes += Buffer.byteLength(buffer);
                yield buffer;
                buffer = '';
            }
        }
        buffer += ']}\n';
        stats.uncompressedBytes += Buffer.byteLength(buffer);
        yield buffer;
    }
    await pipeline(Readable.from(jsonChunks()), createGzip({ level: 9 }), createWriteStream(destination));
    return stats;
}
