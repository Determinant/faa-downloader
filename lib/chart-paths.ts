import path from 'node:path';

export function chartCacheDirectory(cycleDirectory: string): string {
    const directory = path.resolve(cycleDirectory);
    const chartRoot = path.dirname(directory);
    // Standard builds keep all intermediate data outside the publishable charts/
    // tree. Ad-hoc --tile inputs retain their local sibling cache directory.
    return path.basename(chartRoot) === 'charts' && /^\d{4}-\d{2}-\d{2}$/.test(path.basename(directory))
        ? path.join(path.dirname(chartRoot), 'mbtiles', path.basename(directory))
        : path.join(directory, 'mbtiles');
}

export function chartMbtilesPath(tifPath: string): string {
    return path.join(chartCacheDirectory(path.dirname(tifPath)), path.basename(tifPath).replace(/\.tif$/i, '.mbtiles'));
}
