import sharp from 'sharp';

type Part = { input: Buffer; left: number; top: number };

export async function compositeTile(parts: Buffer[]): Promise<Buffer> {
    if (parts.length === 1 && parts[0].toString('ascii', 0, 4) === 'RIFF' &&
        parts[0].toString('ascii', 8, 12) === 'WEBP') return parts[0];
    return sharp({ create: { width: 256, height: 256, channels: 4, background: '#00000000' } })
        .composite(parts.map(input => ({ input, left: 0, top: 0 })))
        .webp({ quality: 92 }).toBuffer();
}

export async function overviewTile(parts: Part[]): Promise<Buffer> {
    const pixels = await sharp({
        create: { width: 512, height: 512, channels: 4, background: '#00000000' }
    }).composite(parts).raw().toBuffer();
    // Keep temporary source overviews lossless; encode the final mosaic only once.
    return sharp(pixels, { raw: { width: 512, height: 512, channels: 4 } })
        .resize(256, 256, { kernel: 'lanczos3' }).png().toBuffer();
}

export async function overzoomTile(input: Buffer, x: number, y: number, scale: number): Promise<Buffer> {
    const size = 256 / scale;
    const left = Math.floor((x % scale) * size);
    const top = Math.floor((y % scale) * size);
    return sharp(input).extract({ left, top, width: Math.max(1, Math.floor(size)), height: Math.max(1, Math.floor(size)) })
        .resize(256, 256, { kernel: 'lanczos3' }).png().toBuffer();
}
