import fs from 'node:fs/promises';

const PDF_HEADER = Buffer.from('%PDF-', 'ascii');
const PDF_TRAILER_BYTES = 64 * 1024;

export async function validatePdfFile(filePath: string): Promise<void> {
    const handle = await fs.open(filePath, 'r');
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size < PDF_HEADER.length) {
            throw new Error(`PDF is empty or is not a regular file: ${filePath}`);
        }

        const header = Buffer.alloc(PDF_HEADER.length);
        const headerRead = await handle.read(header, 0, header.length, 0);
        if (headerRead.bytesRead !== header.length || !header.equals(PDF_HEADER)) {
            throw new Error(`File does not have a PDF header: ${filePath}`);
        }

        const trailerLength = Math.min(stat.size, PDF_TRAILER_BYTES);
        const trailer = Buffer.alloc(trailerLength);
        const trailerRead = await handle.read(
            trailer,
            0,
            trailer.length,
            stat.size - trailer.length
        );
        const trailerText = trailer.subarray(0, trailerRead.bytesRead).toString('latin1');
        const matches = [...trailerText.matchAll(/startxref\s+(\d+)\s+%%EOF\s*$/g)];
        const finalTrailer = matches.at(-1);
        const xrefOffset = finalTrailer ? Number(finalTrailer[1]) : Number.NaN;
        if (!Number.isSafeInteger(xrefOffset) || xrefOffset < PDF_HEADER.length ||
            xrefOffset >= stat.size) {
            throw new Error(`PDF does not have a valid final trailer: ${filePath}`);
        }

        const xref = Buffer.alloc(Math.min(32, stat.size - xrefOffset));
        const xrefRead = await handle.read(xref, 0, xref.length, xrefOffset);
        const xrefText = xref.subarray(0, xrefRead.bytesRead).toString('latin1');
        if (!/^(?:xref\b|\d+\s+\d+\s+obj\b)/.test(xrefText)) {
            throw new Error(`PDF startxref does not point to an xref section: ${filePath}`);
        }
    } finally {
        await handle.close();
    }
}
