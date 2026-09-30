import path from 'node:path';

const cycleName = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

export function chartCyclePaths(outputRoot: string, cycle: string) {
    const root = path.resolve(outputRoot);
    return {
        legacyDirectory: path.join(root, 'charts', cycle),
        sourceDirectory: path.join(root, 'sources', cycle, 'charts'),
        cacheDirectory: path.join(root, 'mbtiles', cycle),
        deliveryDirectory: path.join(root, 'charts', cycle, 'mbtiles')
    };
}

function standardChartCycle(directory: string) {
    const resolved = path.resolve(directory);
    const name = path.basename(resolved);
    const parent = path.dirname(resolved);
    if (cycleName(name) && ['charts', 'sources'].includes(path.basename(parent))) {
        return chartCyclePaths(path.dirname(parent), name);
    }
    if (name === 'charts' && cycleName(path.basename(parent)) && path.basename(path.dirname(parent)) === 'sources') {
        return chartCyclePaths(path.dirname(path.dirname(parent)), path.basename(parent));
    }
    return undefined;
}

/** Resolve a cycle once, retaining local ad-hoc layouts outside output/charts. */
export function chartLayoutForCycleDirectory(cycleDirectory: string) {
    const directory = path.resolve(cycleDirectory);
    const standard = standardChartCycle(directory);
    if (standard?.legacyDirectory === directory) return standard;
    return {
        legacyDirectory: directory,
        sourceDirectory: directory,
        cacheDirectory: path.join(directory, 'mbtiles'),
        deliveryDirectory: path.join(directory, 'mbtiles')
    };
}

export function chartSourceDirectory(cycleDirectory: string): string {
    return chartLayoutForCycleDirectory(cycleDirectory).sourceDirectory;
}

export function legacyChartCycleDirectory(sourceDirectory: string): string | undefined {
    const directory = path.resolve(sourceDirectory);
    const layout = standardChartCycle(directory);
    return layout?.sourceDirectory === directory ? layout.legacyDirectory : undefined;
}

export function chartCacheDirectory(cycleDirectory: string): string {
    const directory = path.resolve(cycleDirectory);
    // Standard builds keep all intermediate data outside the publishable charts/
    // tree. Ad-hoc --tile inputs retain their local sibling cache directory.
    return standardChartCycle(directory)?.cacheDirectory ?? path.join(directory, 'mbtiles');
}

export function chartMbtilesPath(tifPath: string): string {
    return path.join(chartCacheDirectory(path.dirname(tifPath)), path.basename(tifPath).replace(/\.tif$/i, '.mbtiles'));
}
