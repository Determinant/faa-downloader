# Chart cutlines and seam verification

The tiler removes collars, scale rulers and displaced insets before reprojection.
The delivery packager composites those already-clipped sheets; it cannot restore
imagery removed by a source cutline. Keep FAA georeferencing and chart-family
identity intact. Do not fill a hole with another chart family, shift a sheet to
hide it, or stretch nearby chart content across missing coverage.

## IFR printed frames

`lib/ifr-neatlines.ts` records the reviewed September 3, 2026 frames for every
configured CONUS IFR sheet: 37 low and 12 high. Each record retains the reference
TIFF's SHA-256, image dimensions, measured pixel/line bounds and WGS84 corners.
The source FAA raster's affine transform includes rotation. The tiler joins these
corners in the FAA Lambert projection, so edges follow the straight printed frame
instead of geographic-coordinate chords that curve through the collar.

Keep the full black frame stroke. Adjacent sheets commonly meet within that
stroke; discarding it creates a transparent strip even when the FAA printed
frames overlap. This deliberately leaves a visible printed border at some joins.
Scale rulers and footer labels remain excluded. No source georeferencing or
imagery is synthesized to hide a seam.

The community `lib/chartmaker-cutlines.ts` remains the reproducible, unmodified
import from its pinned upstream source. Sectionals and TACs continue using their
reviewed definitions and local inset corrections. The measured IFR records
override the community IFR corners. A newly configured IFR sheet fails until
it has a reviewed measured frame.

## Check the reference data

From the repository root, with the original reference TIFFs available:

```bash
npm run check:chart-neatlines -- \
  --sources=dist/sources/2026-09-03/charts \
  --output=tmp/ifr-neatlines.json
```

The check verifies all 49 source hashes and dimensions, maps the active cutline
back to source pixels using the complete affine transform, and reads long image
strips along all four sides to confirm they follow actual printed border ink.
It rejects a different edition instead of treating it as the reviewed reference.
The report is evidence for those exact inputs, not proof about a later edition.

For a new review, inspect the main-map border at native source resolution,
including rotated sheets and the split L06 panels. Record the source hash and
pixel bounds, and convert the four pixel/line corners using:

```bash
gdaltransform -t_srs EPSG:4326 path/to/ifr-enroute-low-l09.tif
```

Supply the corner pixel/line pairs on standard input in top-left, top-right,
bottom-right, bottom-left order. Update the reference record only after reviewing
the source strips and the resulting mosaic. Do not copy old inset coordinates or
apply a blanket geographic buffer: some older masks clipped valid content while
others already included parts of the collar.

`test/chart-seams.test.ts` checks independently recorded recovered-gap locations,
all sectional footprint samples, the two documented source separations, and the
rotated-source transform. The reference image check supplements these fast tests.

## September 3, 2026 audit

The October 6 investigation matched all 162 source hashes and all sheet identities
to the then-published package manifest. Its scope included 58 sectionals,
37 IFR-low sheets, 12 IFR-high sheets, 34 TACs and 21 flyways. TACs, flyways and
island panels have intentional disjoint coverage; they are not expected to form
a nationwide continuous base.

The old IFR-low masks contained nine enclosed holes, including the reported
L07/L09 seam north of Las Vegas and the L11/L13 seam south of McCall. The problem
was source clipping: a nationwide zoom-8 alpha scan found no missing interior
pixels inside the existing masks in any of the five families. The 58 sectional
footprints had no enclosed holes or nearby disconnected joins. IFR-high had no
enclosed holes, but the H01/H03 join had an open gap near the western edge.

Remeasuring all IFR frames closes the reported gaps and the other recoverable
seams, including the IFR-high candidates. The enclosed IFR-low gap area falls
from approximately 18,687 to 188 square kilometres. The remaining two thin
separations lie outside every neighboring printed frame:

| Source join | Approximate extent | Maximum width |
| --- | --- | --- |
| L07/L08/L09 near JONOT, northeast of Las Vegas | 114.183–114.141°W, 36.599–36.606°N | 0.17 NM |
| Primarily L29/L30, with L28/L34 closing the ends | 83.034–76.720°W, 40.363–41.173°N | 0.20 NM |

These limits were checked against the original FAA TIFFs. Extending those masks
farther begins retaining unprinted collar space and footer labels. Preserve and
report the source limits rather than asserting that every source join is seamless.
The wider Las Vegas and McCall gaps were clipping defects; their small residuals
when removing the border were the stroke's thickness, not evidence of a datum or
georeferencing error.

## Rebuild and publication

Measured coordinates and their provenance participate in each sheet's build
configuration hash, so existing IFR receipts become stale automatically. VFR
receipts remain reusable. Rebuild sheets, regenerate the verified sheet manifest,
and then regenerate the spatial/zoom packages. A manifest-only refresh cannot
repair old imagery. `npm run build:charts` performs those stages in order;
single-sheet and standalone maintenance commands are documented in the README.

Verify the rebuilt alpha masks and native tile inventory before publishing.
Upload all immutable replacement packages before switching the delivery manifest.
Retain older published archives for open clients and saved offline snapshots.
Browsing clients discover the same-cycle correction through normal manifest
revalidation; saved regional snapshots retain their prior identities until updated.
