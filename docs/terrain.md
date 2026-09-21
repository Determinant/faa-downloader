# Terrain packages

`npm run build:terrain` builds elevation packages directly from the USGS
[3D Elevation Program (3DEP)](https://www.usgs.gov/3d-elevation-program), using the
current 1-arc-second (approximately 30-metre) seamless DEM GeoTIFFs. Delivery
cells have exactly **2.45 arc-seconds** of latitude and longitude spacing; coarser
overviews double that spacing at each level. Elevations use compressed signed
16-bit integer metres. USGS makes
these products available without use restrictions. Published packages retain the
credit: “3DEP data courtesy of the U.S. Geological Survey”.

The builder uses the official [USGS staged-products directory](https://prd-tnm.s3.amazonaws.com/index.html?prefix=StagedProducts/Elevation/1/TIFF/current/),
linked from [The National Map download documentation](https://www.usgs.gov/the-national-map-data-delivery/gis-data-download).
It enumerates the `current/` directory directly, selecting `USGS_1_*` tiles and
excluding historical revisions and stray files from other elevation products.
No Mapzen service or Terrarium PNG conversion is involved in this build.

```
npm run build:terrain -- --estimate
npm run build:terrain -- --regions=regions.json
# Later, run the same command to check upstream revisions and update changed data.
npm run build:terrain -- --regions=regions.json
```

Requires Node.js 24+ and GDAL with `gdalinfo`, `gdalbuildvrt`, `gdalwarp`, and the
GeoTIFF/ENVI drivers on PATH. Tests with synthetic GeoTIFFs also use `gdal_translate`.

The default `data/terrain-regions.json` contains the same Census-derived state and
territory envelopes as ZLayer's `src/offline/regions.ts`. Keep the definitions
synchronized when region coverage changes. Alaska has separate envelopes on the
two sides of the date line. Custom region files use:

```json
[{"id":"sample","title":"Sample","bounds":[[-122.01,37.01,-122.009,37.011]]}]
```

The default envelopes produce **25,956 archives**, containing about **12.7 GiB** of
uncompressed delivery grids before gzip (including all overviews). The full national
build verified on 2026-09-21 used **2.91 GB compressed**, including spatial indexes,
provenance, and the manifest. Compression depends on the source data; retained older
versions add to the deployment's disk usage. `--estimate` reports uncompressed grid
geometry, not compressed deployment size. Source GeoTIFF storage is additional; the 30-metre source has
roughly one ninth as many samples as the previous 10-metre source. Online builds
report the selected source inventory's total byte size before downloading. `--estimate`
reports delivery geometry only; it does not query USGS, download, or write files.
Terrain remains a standalone product and is **not** invoked by `build:charts`.

## Detecting updates and resuming builds

Every online run reads the paginated USGS object listing, which supplies each
GeoTIFF and metadata XML file's ETag, byte length, and last-modified time. There is
no interval during which source freshness checks are silently skipped.

- An unchanged URL, strong ETag, and size reuse the existing file after verifying
  its local SHA-256. ETags are opaque version identifiers, not assumed to be MD5s.
- Changed or newly available files are downloaded with `If-Match` to pin the
  discovered revision. The shared streaming downloader retries transient failures
  and resumes partial transfers. Each partial belongs to one exact object version.
- XML metadata revisions are checked independently. A metadata-only update does
  not redownload the GeoTIFF or rerun elevation processing.
- Raster and XML footprints must match the named one-degree tile, allowing a
  one-arc-minute border margin, including on cache reuse. Border widths vary,
  and some XML retains a wider legacy border. Discovery uses that conservative
  envelope; measured raster bounds determine build dependencies and recorded
  source coverage.
- Source files and completed output batches are checkpointed immediately. A later
  failure leaves the published manifest intact; rerunning reuses completed work.
- Output batch fingerprints include source content hashes, geometry, the GDAL
  version, and a processing version. Only affected batches are rebuilt. Damaged
  output archives or build metadata are repaired from verified source files.
- If nothing changed, the published manifest and its `generatedAt` are preserved.
  A successful run still logs the freshness check and reuse counts.

The object listing and small metadata requests consume network traffic. Verified,
unchanged GeoTIFF bodies are not fetched again. Source versions and immutable
published outputs are retained; old versions are not automatically pruned.

`--rebuild` regenerates derived packages while still reusing verified, current
GeoTIFFs. `--source-directory=DIR` imports local `.tif`/`.tiff` files with matching
FGDC `.xml` sidecars and performs no network requests. Local imports require the
same single-band, north-up NAD83 elevation-in-metres format as the USGS standard
product; their content hashes detect changes. `--output=DIR` changes the build root.

## Elevation processing and provenance

Numeric source elevations are mosaicked and reduced using GDAL's **maximum**
resampler onto an EPSG:4326 geographic grid anchored at longitude -180, latitude
90. Level 11 has 2.45-arc-second cells; levels 10 through 1 double cell spacing at
each step. These levels are geographic overview levels, not Web Mercator zooms.
The same angular spacing applies in Alaska and the contiguous states.

Each output cell retains the maximum contributing valid source elevation, rounded
**upward** to the next whole metre (less than one metre of additional quantization).
Mosaics use the finest input resolution, and source overviews are disabled, so
neither an adjacent coarser raster nor averaged overviews remove source peaks
before the maximum reduction. This preserves peaks available in the 30-metre source; it
does not recover features absent from that source or establish Garmin/SVT accuracy.
Processing groups up to 8×8 native tiles per GDAL call and extracts 2×2 archives.
GDAL runs only at the finest, 2.45-arc-second level. Coarser levels take the maximum
of each 2×2 group of child cells, preserving peaks without rereading the source
GeoTIFFs. Missing child archives remain NoData, so overview coverage follows the
packaged finest-level coverage. Completed batches are reported immediately;
long-running raster batches also report elapsed time every 30 seconds.
Source NoData and uncovered areas use the reserved int16 value -32768. Padded cells
past the date line or poles remain missing. Unknown ocean/cross-border cells are
not invented as zero elevation. Coverage envelopes describe packaged grids, not a
promise that every sample inside them has USGS data.

Source vertical datums are recorded from each USGS metadata XML. Heights retain
those native orthometric references, in metres; the consumer converts them to feet after decoding. Horizontal
reprojection explicitly disables automatic vertical shifts. This does **not**
normalize all regional datums to one geoid model. Ellipsoidal heights and metadata
with unknown/missing units are rejected. See the
[USGS datum documentation](https://www.usgs.gov/faqs/what-projection-horizontal-datum-vertical-datum-and-resolution-a-usgs-digital-elevation-model).

Each build publishes an immutable `<sha256>.terrain-sources.json` provenance file
containing source URLs, ETags, modification times, SHA-256 checksums, metadata
checksums, declared vertical datums, and processing details. The manifest references
this file by hash and byte length so the large inventory stays out of discovery.

## Storage and publication

Delivery files go under `dist/charts/terrain/`:

- `<sha256>.dem`: compressed elevation archives.
- `<sha256>.terrain`: spatial indexes.
- `<sha256>.terrain-sources.json`: source and processing provenance.
- `manifest.json`: the current coverage pointer, published last.

Local inputs, receipts, and batch checkpoints live under `dist/terrain-cache/`.
The build lock is outside the delivery tree. Upload all immutable delivery files
before `manifest.json`; the existing charts uploader already uses that ordering.
Enable the same cross-origin GET/HEAD access as other chart archives. Immutable
files may use long-lived HTTP caching; the manifest must be revalidatable. Serve
`.dem` as octet-stream and `.terrain` as JSON or octet-stream. Do not apply
`Content-Encoding: gzip` to DEM containers.

Running with fewer regions replaces the published coverage list with that
selection. Use the full intended list when extending a deployment. Existing
immutable files remain available to older saved selections. ZLayer discovers this
product independently of FAA chart cycles; existing offline selections need
**Verify / update** to acquire it. Its online PNG fallback remains independent.

## Delivery format, version 2

The manifest and indexes declare `schemaVersion: 2`, `encoding: int16-metres-gzip`,
`grid: EPSG:4326`, `resolutionArcSeconds: 2.45`, `minZoom: 1`, and `maxZoom: 11`.
At level `z`, cell spacing is `2.45 / 3600 * 2 ** (11 - z)` degrees in both axes.
Tile `(x, y)` starts at `(-180 + x * 256 * spacing, 90 - y * 256 * spacing)`.
The last tiles are padded where the global extent does not divide into whole tiles.

Each shard records `zoom`, `x`, `y` (aligned to 64 native tiles), `file`, `sha256`,
and `byteLength`. Each `.terrain` index contains at most 1,024 archive records.
Archives have even `x`/`y` origins and content-addressed `.dem` filenames.

A DEM contains four 256×256 grids in NW, NE, SW, SE order. Its 56-byte header starts
with ASCII `ZDEM0002`, then little-endian uint32 `zoom`, `x`, `y`, count `4`, and four
absolute uint32 offset/length pairs. The contiguous payloads are independent gzip
streams of 65,536 little-endian int16 metre values. Missing samples are -32768.
Archives are bounded to 2 MiB and indexes to 512 KiB.

ZLayer converts geographic elevations into the requested display tile in its
worker. Close-up map zooms reuse the same 2.45-arc-second data; display pixel
footprints retain maxima from intersecting native cells. Higher display zooms do
not require additional packages. A bounded 8 MiB decoded geographic cache allows
neighbouring display tiles to share source grids.

Deploy the updated ZLayer consumer **before publishing the 2.45-arc-second
manifest**. It accepts both geographic pairs: 4.9 arc-seconds / level 10 and
2.45 arc-seconds / level 11. Levels 1–10 keep exactly the same geometry; level 11
adds four times as many cells per area. Existing geographic and legacy
float32/Mercator offline selections keep working at their saved resolution.
**Verify / update** acquires the finer packages. Older clients that only accept
4.9-arc-second manifests need the consumer update first.

This resolution increase reuses the existing 1-arc-second USGS source cache;
only derived grids need rebuilding. Retained immutable files are not automatically
pruned: publishing a new manifest does not reclaim older delivery files or source
caches. Include retained versions when checking the deployment's disk budget.

Contours remain route-dependent and are generated in the browser. Changing the
source does not establish an end-to-end rendering speedup.

`test/terrain.test.ts` exercises peak-preserving GDAL conversion, exact angular spacing, quadrant ordering,
negative/missing samples, source revision detection, unchanged and metadata-only
runs, selective rebuilds, interrupted updates, cache repair, local inputs, and
date-line selection. GDAL integration tests report an explicit skip if the CLI
tools are absent. Network tests use a simulated USGS object store.
