/** Exact raster-cell intersection of an oriented rectangle. Coordinates are in
 * analysis cells. A summed-area table accepts clear interiors in O(1); only
 * boundary rectangles need separating-axis checks. Outside is always blocked. */
export function glideRectangleChecker(clear: Uint8Array, width: number, height: number) {
    const stride = width + 1, blocked = new Uint32Array(stride * (height + 1));
    for (let y = 0; y < height; y++) {
        let row = 0;
        for (let x = 0; x < width; x++) {
            row += Number(!clear[y * width + x]);
            blocked[(y + 1) * stride + x + 1] = blocked[y * stride + x + 1] + row;
        }
    }
    const count = (left: number, top: number, right: number, bottom: number) =>
        blocked[bottom * stride + right] - blocked[top * stride + right] -
        blocked[bottom * stride + left] + blocked[top * stride + left];
    return (cx: number, cy: number, dx: number, dy: number, halfLength: number, halfWidth: number): boolean => {
        const adx = Math.abs(dx), ady = Math.abs(dy);
        const rx = adx * halfLength + ady * halfWidth, ry = ady * halfLength + adx * halfWidth;
        const x0 = Math.floor(cx - rx), x1 = Math.ceil(cx + rx), y0 = Math.floor(cy - ry), y1 = Math.ceil(cy + ry);
        if (x0 < 0 || y0 < 0 || x1 > width || y1 > height) return false;
        if (!count(x0, y0, x1, y1)) return true;
        const projection = (adx + ady) / 2;
        for (let y = y0; y < y1; y++) {
            if (!count(x0, y, x1, y + 1)) continue;
            for (let x = x0; x < x1; x++) {
                if (clear[y * width + x]) continue;
                const ox = x + 0.5 - cx, oy = y + 0.5 - cy;
                // AABB axes were checked by the loop bounds; these are the
                // remaining two separating axes of rectangle versus cell.
                if (Math.abs(ox * dx + oy * dy) <= halfLength + projection &&
                    Math.abs(-ox * dy + oy * dx) <= halfWidth + projection) return false;
            }
        }
        return true;
    };
}
