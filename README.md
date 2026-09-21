# FAA Downloader

FAA Downloader is a collection of build tools for creating local, offline-friendly copies of FAA reference material:

- FAR: a responsive, searchable PWA generated from Title 14 CFR data.
- AIM: a local mirror of the FAA Aeronautical Information Manual HTML site.
- Charts: a downloader and GDAL-based tiler for current FAA aeronautical charts,
  plus NASR navigation data, daily obstacles, a d-TPP procedure catalog, and Chart Supplement page indexes.

The generated data is intended for personal reference and offline use. It is not an official FAA publication and should not replace current FAA source material, notices, or operational requirements.

## What it builds

| Command | Product | Output |
| --- | --- | --- |
| npm run build:far | FAR PWA from the current eCFR snapshot | dist/far/ |
| npm run build:aim | Offline-capable AIM mirror | dist/aim/ |
| npm run build:charts | Charts, MBTiles, navigation, daily obstacles, historical filed routes, procedures, and Chart Supplement indexes | dist/charts/ |

Run only the product you need, or build them into the shared dist/ directory.
`build:far` builds FAR only. `build:charts` includes the chart metadata and packaging
stages automatically; no follow-up build commands are needed.
It also writes `dist/charts/cycles.json` beside the dated directories, containing
`schemaVersion`, `generatedAt`, and a `cycles` array of ISO dates, newest first.
Run `npm run build:chart-cycles` to refresh just this index from existing output
without downloading or rendering charts. Publish it after the dated files.
Historical filed-route frequencies are packaged during the navigation stage.
Daily obstacles are published separately at `charts/obstacles/manifest.json`, with
their own source timestamp independent of the chart/NASR cycle.

## Data sources

- FAR current snapshots: [eCFR](https://www.ecfr.gov/)
- FAR annual editions: [GovInfo CFR collection](https://www.govinfo.gov/app/collection/cfr)
- AIM: [FAA AIM HTML publication](https://www.faa.gov/air_traffic/publications/atpubs/aim_html/)
- Charts: [FAA Aeronautical Information Services](https://aeronav.faa.gov/)
- Airports/navigation: [FAA 28-day NASR Subscription](https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/)
- Obstacles: [FAA Daily Digital Obstacle File](https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/dailydof/)
- Procedures: [FAA digital TPP](https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/dtpp/)
- Historical filed-route frequencies: [Aeronautic AQ](https://aq.aeronautic.ai/), from its public [SQLite snapshot](https://aeronautiql.s3.amazonaws.com/databases/routes.sqlite.zst)

The source date and scope are written into the generated FAR interface. Chart downloads are selected from the latest available FAA directory entries. A missing configured raster aborts discovery; a missing PDF volume produces a warning. A listed file that fails to download aborts the build.

FAA chart GeoTIFFs contain the entire printed sheet, including collars, legends, and
insets that are not part of the accurately georeferenced main chart. The chart builder
clips every configured VFR and IFR raster to a reviewed neatline before reprojection
and MBTiles generation. The sectional, TAC, and IFR cutlines are adapted
from the MIT-licensed [N129BZ/chartmaker](https://github.com/N129BZ/chartmaker)
project, with local inset corrections for the Miami and Puerto Rico TACs.
IFR corners are joined in the FAA raster's Lambert projection so wide edges
follow the printed neatline without retaining coordinate rulers; flyway neatlines were
measured against the FAA 2026-09-03 rasters. A new VFR or IFR raster intentionally
fails tiling until its cutline is reviewed and added.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the retained license notice.

## Quick start

Requirements:

- Node.js 24 or newer (the packager uses built-in SQLite)
- npm
- unzip on PATH for safe archive validation and extraction
- zip on PATH for NASR and obstacle build test fixtures
- xsltproc on PATH for FAR generation
- GDAL CLI tools on PATH for chart tiling: gdalinfo, gdal_translate, gdalwarp, and gdaladdo
  (manifest-only refreshes also use gdalinfo to read archive bounds and zoom limits)
- Standalone terrain builds also use gdalbuildvrt and GDAL's GeoTIFF/ENVI drivers

Install dependencies and run the checks:

~~~bash
npm ci
npm run check
npm test
~~~

Build a product:

~~~bash
npm run build:far      # FAR PWA
npm run build:aim      # AIM mirror
npm run build:charts   # Charts, MBTiles, navigation, daily obstacles, procedures, and CS indexes
~~~

On NixOS, the external command-line prerequisites can be provided with:

~~~bash
nix-shell -p libxslt gdal unzip zip
~~~

## Targeted rebuilds and maintenance

Use these when updating one stage. The standalone commands and `build:charts`
share the same builders; standalone stages require the inputs described below.
Paths are relative to `dist/` (or the selected `--output` root).

| Command | Inputs | Output and responsibility |
| --- | --- | --- |
| npm run build:nav | Downloads current NASR groups and AQ history, or uses explicit local sources | Publishes the complete cycle's `charts/<cycle>/nav/` bundle: map points, airways, preferred routes, SID/STAR sequences, and route history |
| npm run build:obstacles | Downloads the full FAA Daily DOF CSV ZIP, or uses `--source=FILE` | Publishes `charts/obstacles/manifest.json` and a compressed GeoJSON snapshot, independent of chart cycles |
| npm run build:terrain | Checks current USGS 3DEP GeoTIFF revisions and downloads changed files, or imports local GeoTIFFs | Publishes 4.9-arc-second integer-metre elevation packages and source provenance at `charts/terrain/` (about 3.3 GiB before gzip for default coverage); independent of chart cycles; run `--estimate` first ([details](docs/terrain.md)) |
| npm run build:procedures | Downloads d-TPP XML or uses `--source-xml`; indexes any existing TPP PDFs | Publishes `charts/<cycle>/tpp/` with plate URLs and available PDF page targets; does not download the books |
| npm run build:supplements | Existing regional Chart Supplement PDFs plus cached/downloaded XML or `--source-xml` | Publishes `charts/<cycle>/cs/` airport page indexes; does not download the books |
| npm run build:chart-packages | Verified sheet MBTiles and their manifests in `mbtiles/<cycle>/` | Publishes delivery archives and offline region indexes in `charts/<cycle>/mbtiles/` |
| npm run build:chart-manifests | Existing sheet MBTiles, receipts, and source TIFFs | Verifies sheets and refreshes `mbtiles/<cycle>/chart-manifest.json`; also migrates legacy sheet and delivery layouts |
| npm run chart-cutlines | Reviewed chartmaker source and checked-in cutlines | Verifies or regenerates source coordinates during development |

`build:nav` owns the navigation data; `build:procedures` owns the plate catalog and
page indexes. Manifest maintenance can move legacy files and should run on local
build output before upload. See the migration instructions below.

The former `build` and `build:nasr` commands are now `build:far` and `build:nav`,
respectively. Update existing automation to use the explicit names.

Single-sheet tiling uses `npm run build:charts -- --tile=PATH` (the former
`tile:chart` alias). Use `build:aim` for AIM updates; the former `download-aim`
alias's create-only behavior is available through
`node --import=tsx download-aim.ts --output=dist/aim`.

## FAR PWA

npm run build:far fetches the current eCFR XML for Title 14, filters it to the configured volumes and parts, and generates a split FAR site under dist/far/.

The output includes:

- index.html, the PWA shell and entry point
- far-parts/, one HTML page per included part
- vendor/, locally bundled TreeView assets
- manifest.webmanifest, icons, and service-worker.js
- normalized and combined XML build intermediates

The interface is designed for desktop and narrow screens. On phones and small tablets, the table of contents and search are available from the right-side menu. Search is local: the generated corpus is embedded in the shell and indexed in the browser with MiniSearch, so no search server or CDN is required.

Serve dist/far/ from localhost or HTTPS to test installation and service-worker behavior. Upload the complete directory for deployment; uploading only index.html will cause part-page or asset 404s.

FAR and AIM use separate, product-specific manifest IDs, so browsers can install both apps from the same site without treating one as an update to the other. If either app was installed from a build created before these IDs were introduced, uninstall that older copy once before reinstalling both apps.

### FAR source options

The npm script accepts the same options as build-far.ts through npm argument forwarding:

~~~bash
npm run build:far -- --source=ecfr --vols=1,2,3
npm run build:far -- --source=annual --year=2025
npm run build:far -- --source-xml=combined-ecfr.xml --date=2026-04-30
~~~

Useful options:

~~~text
--source=ecfr|annual
--date=YYYY-MM-DD
--year=YYYY
--vols=1,2,3
--title=14
--chapter=I
--source-xml=FILE
--combined=FILE
--far=FILE
--html=FILE
--xsl=FILE
--parts-dir=DIR
--help / -h
~~~

The default XSLT template is cfr-ecfr.xsl at the repository root. It is a source asset used during the build, not generated output.

For a fully local FAR build, provide --source-xml and an explicit --date; no source download is then required.

## AIM mirror

npm run build:aim downloads the FAA AIM HTML pages and same-site assets into dist/aim/. It rewrites local links so the mirror can be browsed from its index.html entry point, replaces the FAA-hosted search form with an offline full-text search of the downloaded manual, and adds install metadata, icons, and a service worker.

The service worker precaches the complete mirror, including all figures under images/, so the installed AIM remains fully illustrated while offline.

The mirror preserves external links such as FAA publications and Google-hosted fonts. Like FAR search, AIM search indexes its generated corpus in the browser with the bundled MiniSearch library; it stays inside the mirror and also works when the files are opened directly from disk. Service-worker installation requires localhost or HTTPS; opening the file directly from disk cannot register it.

Options are available with:

~~~bash
node --import=tsx download-aim.ts --help
~~~

For example:

~~~bash
npm run build:aim -- --concurrency=8
~~~

The --clean option used by the npm build replaces an existing mirror only after a successful staged download. A previous mirror is retained temporarily as a hidden sibling during the replacement process.

## FAA charts

npm run build:charts discovers the latest available FAA editions, downloads PDFs and ZIP archives, extracts the required GeoTIFFs, creates trimmed per-sheet WebP MBTiles, stitches spatial/zoom delivery packages, and builds the current NASR, geographic magnetic model, historical filed routes, d-TPP, Chart Supplement metadata, and daily obstacles.

The obstacle stage checks the FAA's daily snapshot on every normal chart build,
reusing the downloaded ZIP only when its source ETag is unchanged. A daily run of
`build:charts` therefore refreshes obstacles without waiting for a chart cycle.
Use `npm run build:obstacles` to refresh only that dataset, or append
`-- --source=/path/to/DAILY_DOF_CSV.ZIP` for a fully local build.
See [Daily obstacles](docs/obstacles.md) for the schema and publication contract.

The selected PDF coverage includes all 25 TPP volumes: AK, EC1–EC3, NC1–NC3,
NE1–NE4, NW1, SC1–SC5, SE1–SE4, and SW1–SW4. It also includes all nine
Chart Supplements: AK, EC, NC, NE, NW, PAC, SC, SE, and SW. Pacific terminal
procedures are included in Chart Supplement Pacific. PDFs retain the existing
`tpp-<volume>.pdf` and `cs-<region>.pdf` filenames under their publication dates.

The configured raster footprint includes every FAA Sectional, all 34 Terminal Area
(TAC) sheets and 21 Flyway (FLY) sheets, and the main L01-L36 conterminous U.S. IFR
Low Enroute sheets: 150 independently trimmed rasters in total. The 30 TAC archives
include paired terminal sheets for Anchorage/Fairbanks, Denver/Colorado Springs,
Seattle/Portland, and Tampa/Orlando. Flyways are extracted only where the FAA provides
a georeferenced FLY sheet. The unreferenced Anchorage Graphic and New York VFR
Planning Charts images are excluded, as are displaced insets within chart sheets.
Multi-raster products and antimeridian-crossing panels are split into independently
trimmed MBTiles where required.

The downloader and MBTiles renderer each use four concurrent workers by default.
Downloads stream to `.part` files, report progress, and resume after interruption when
the FAA server supports byte ranges. Tune network and rendering concurrency independently
when needed:

~~~bash
npm run build:charts -- --concurrency=8 --tile-concurrency=4
~~~

This repository is also the build and maintenance source for the chart artifacts
published at `https://charts.tedyin.com/charts/`. Downstream applications such as
ZLayer should consume those published artifacts together with explicit FAA edition and
build provenance rather than treating the site as an unrelated third-party source.

Chart output is organized by publication date; daily obstacles have a rolling snapshot:

~~~text
dist/
├── charts/
│   ├── cycles.json
│   ├── obstacles/
│   │   ├── obstacles-<sha256>.geojson.gz
│   │   └── manifest.json
│   └── YYYY-MM-DD/
│       ├── *.pdf
│       ├── *.tif
│       ├── mbtiles/
│       │   ├── <kind>-z<zoom>-r<depth>-<x>-<y>-<sha256>.mbtiles
│       │   └── manifest.json
│       ├── nav/
│       │   ├── airports.geojson
│       │   ├── fixes.geojson
│       │   ├── vfr-waypoints.geojson
│       │   ├── navaids.geojson
│       │   ├── airways.json
│       │   ├── terminal-procedures.json
│       │   ├── magnetic-model.json
│       │   ├── preferred-routes.json
│       │   ├── route-history.json.gz
│       │   └── manifest.json
│       ├── nasr/
│       │   └── *_CSV.zip
│       ├── cs/
│       │   └── catalog.json
│       └── tpp/
│           ├── catalog.json
│           └── manifest.json
├── mbtiles/                         # local build cache; do not upload
│   └── YYYY-MM-DD/
│       ├── <sheet>.mbtiles
│       ├── <sheet>.mbtiles.build.json
│       ├── chart-packages-<output-id>.build.json
│       └── chart-manifest.json
├── supplements/                     # local XML and index-build cache; do not upload
│   ├── afd_<edition>.xml
│   └── YYYY-MM-DD.build.json
├── route-history/                   # local AQ snapshot cache; do not upload
│   └── <etag-sha256>.sqlite.zst
├── obstacles/                       # local daily FAA ZIP cache; do not upload
│   └── <etag-sha256>.zip
└── zips/                            # local source cache; do not upload
    └── YYYY-MM-DD/
        └── *.zip
~~~

Downloaded cycle PDFs and ZIP files are reused on subsequent runs; rolling obstacle and route-history sources are checked for updates. Each MBTiles file has a build receipt containing source, output, and tiler-configuration hashes; cached tiles are reused only while that receipt still matches. Generated chart data is ignored by Git because a complete collection is several gigabytes. The chart builder currently produces the download and tile data; it does not provide a chart-viewer PWA.

Large per-sheet archives, receipts, build manifests, and GDAL/packaging work files live
under `dist/mbtiles/YYYY-MM-DD/`, alongside the `dist/zips/` source cache. Only the small
delivery archives and their `manifest.json` live in `dist/charts/YYYY-MM-DD/mbtiles/`.
Original PDFs and TIFFs remain at the chart cycle root.
The per-chart lock directory remains beside the source TIFF during a build and is
removed when the operation finishes. Its owner marker is published atomically;
retries reclaim dead owners without deleting another builder's lock. Legacy empty
or malformed lock files can be reclaimed after a one-minute write grace period.

To reorganize a completed build whose receipts still match the current tiler configuration,
run `npm run build:chart-manifests`. It relocates old sheet archives and receipts into
the separate build cache, verifies their hashes, and flattens existing `mbtiles/packages/`
delivery files into the cycle's `mbtiles/` directory. File content identities and region
dependencies do not change. Bounds and zoom limits are read from the generated MBTiles,
including curved IFR edges and each sheet's actual resolution; they are not inferred
from cutline corners or chart-family defaults. This requires `gdalinfo` but does not
render tiles. Normal chart builds relocate caches too. Conflicting old and new files
cause an error rather than overwriting either copy. Wait for running builders to finish
and run migration on local build output, not an actively served directory. Upload
`charts/` without filtering out intermediate MBTiles; neither `dist/mbtiles/` nor
`dist/zips/` belongs on the chart host. Delivery files must arrive before their manifest
even with asynchronous syncing. ZLayers reads `mbtiles/manifest.json`, with fallbacks
for older published layouts. If packages do not exist yet, or imagery/region definitions
changed, follow the manifest command with `npm run build:chart-packages`.

Upgrading from builds made before the Lambert IFR cutline change requires rebuilding
the affected IFR sheets (L02–L04 in the former default coverage). Their old receipts
are intentionally invalid: a manifest refresh cannot correct the imagery. Run
`npm run build:charts -- --tile=dist/charts/YYYY-MM-DD/ifr-enroute-low-l02.tif`
for each affected sheet, then rerun `build:chart-manifests` and `build:chart-packages`.
Alternatively, `npm run build:charts` rebuilds stale sheets as part of the full pipeline.
If a manifest refresh has already stopped on a stale receipt, its completed file moves
are retained and the rebuild commands use the relocated cache safely.

### Spatial/zoom packages and offline regions

`npm run build:charts` includes packaging after sheet tiling. To repackage existing,
verified sheet MBTiles without downloading sources or rerunning GDAL:

~~~bash
npm run build:chart-packages
~~~

The packager pins each input with a temporary hard link before verifying its byte
length, SHA-256, and native zoom range against
`dist/mbtiles/YYYY-MM-DD/chart-manifest.json`. It stitches each chart family in stable sheet-ID order,
generates missing overviews down to zoom 0, and partitions the mosaic by zoom and
spatial grid. Each archive contains only one zoom and at most an 8×8 tile block.
Blocks exceeding 4 MiB, including SQLite overhead, split spatially until they fit.
Low-resolution sheets retain their native maximum; finer neighboring coverage can
use their resampled underlay without upscaling the entire country. Missing native
cells remain transparent. A lone existing WebP tile is reused without recompression;
composited tiles use quality-92 WebP.

`charts/YYYY-MM-DD/mbtiles/manifest.json` (schema 2) indexes file identities, sparse tile masks, source
coverage/provenance, and named offline regions. Region downloads include **all**
intersecting packages at **every** available zoom, not merely the current viewport.
Regions share package references, so neighboring downloads reuse identical files.
The physical split is a zoom-dependent geographic grid; regions are logical download
groups rather than another copy of the imagery. Browsers still cache complete files,
never individual tiles or SQLite pages at the origin.

By default, named regions use the source chart footprints. Supply your own named
regions (for example, states or trip areas) with the same option on either build command:

~~~bash
npm run build:chart-packages -- --regions=regions.json
~~~

The JSON is an array of `{ "id": "trip-area", "title": "Trip area", "bounds":
[[west, south, east, north]] }`. Coordinates are longitude/latitude. Multiple rectangles
are supported; antimeridian regions use separate rectangles on either side of ±180°.
These are chart-imagery dependencies within published coverage, not a promise of
navigation, procedures, weather, basemap availability, or a completed offline-download UI.

Packaging is a separate, restartable stage. Reruns verify source and delivery-file
sizes and SHA-256 hashes, then reuse packages when sheet metadata, regions, archive
size limits, and the packaging version match. A refreshed source-manifest timestamp
alone does not trigger composition or rewrite the delivery manifest. Local receipts
also verify the delivery manifest itself. Missing outputs rebuild; corrupt existing
archives fail verification. Use `npm run build:chart-packages -- --force` to recompose
verified inputs explicitly. Full chart builds apply the same checks to each cached
cycle, including older cycles.

Package filenames contain their content hash; unchanged outputs reuse the same
identity. The local index is replaced atomically
only after every referenced file is present. Upload package files **before** their
manifest; keep previously published hashed files for open/offline clients. Old packages
are deliberately not garbage-collected automatically. For current ZLayers imagery
delivery, upload `charts/YYYY-MM-DD/mbtiles/`; the larger per-sheet archives stay in
the separate build cache and are not additional downloads required by the package feed.

Packaging work directories include the owning process ID. A retry removes directories
left by terminated processes, including their temporary source hard links, while keeping
live packagers' work. Older `.packages-work-*` directories without a process ID have
no verifiable owner and must be removed manually after all packagers have stopped.

Offline region downloads use the same files with bounded concurrency and per-file
retry/resume accounting. This preserves browsing-cache reuse and deduplicates overlapping
regions. A future bulk-transfer bundle could transport those same files if measurements
justify it; it should not introduce a second large regional MBTiles storage format.

To tile one existing TIFF without downloading anything:

~~~bash
npm run build:charts -- --tile=dist/charts/YYYY-MM-DD/chart.tif
~~~

Add `--force` to rebuild an existing MBTiles file. Rebuilds are staged and replaced
atomically, so the previous chart remains usable if GDAL fails. The original FAA PDF
and GeoTIFF stay unchanged; MBTiles are static display derivatives.

The TypeScript tiler clips charts to reviewed neatlines, expands palette
imagery when necessary, uses Lanczos reprojection and overview sampling, writes
quality-92 WebP MBTiles, and builds every display zoom ahead of publication. Browsers
only read and cache these static artifacts; the hosting server performs no chart
rendering. Overview levels extend through factor 128 so high-density clients can retain
2× chart sampling at the widest supported map view.

The 129 community cutlines are generated from the pinned N129BZ/chartmaker shapefiles. Verify
or refresh them from a clean checkout at the pinned commit. The generated coordinates
are checked in, so ordinary download and tile builds do not use chartmaker or require
its checkout:

~~~bash
npm run chart-cutlines -- --chartmaker=/path/to/chartmaker
npm run chart-cutlines -- --chartmaker=/path/to/chartmaker --write
~~~

Flyway cutlines are measured from the FAA source images in `lib/chart-definitions.ts`.
The sampled Flyway boundaries record their source pixel vertices there. Sample each
edge at quarter intervals and transform those pixel/line positions with
`gdaltransform -t_srs EPSG:4326 <source-FLY.tif>` to reproduce their WGS84 coordinates.
Miami's TAC and Flyway boundaries follow the main map around the displaced Florida
Keys inset. Puerto Rico's TAC also overrides the community outline to remove insets;
Detroit and Seattle exclude their inset and legend columns. The archive-content
fixture in `test/fixtures/vfr-terminal-2026-09-03.json` records every TAC archive's
TIFF members for extraction coverage checks.

### NASR airports and navigation data

The chart build also downloads the FAA's current 28-day NASR CSV groups for airports
and landing facilities (`APT`), fixes/reporting points/waypoints (`FIX`), NAVAIDs
(`NAV`), airport frequencies (`FRQ`), airways (`AWY`), preferred/TEC routes (`PFR`), and departure/arrival
procedures (`DP`/`STAR`). It generates compact GeoJSON for selectable map points
and JSON for route records.

`terminal-procedures.json` (`ZLayerTerminalProcedures`, manifest product
`terminal-procedures`) preserves assigned FAA computer identifiers, served airports,
body/transition routes, airport/runway associations, ordered typed points, ICAO
regions and explicit next-point links. Empty BASE tables fail the build before
replacing `nav/`. `NOT ASSIGNED` procedures are excluded; empty route/airport
associations remain empty, never inferred. These are **waypoint sequences**, not
ARINC flight-guidance legs: no vector/turn geometry or altitude/speed constraints
are synthesized. Cache the national file once per export. Rebuild with
`npm run build:nav` and upload the complete cycle's `nav/` directory; MBTiles and
plate books do not need rebuilding. Local `--source-dir` builds now also require
the `DP` and `STAR` CSV ZIPs.

`airports.geojson` includes the FAA location and ICAO identifiers, facility type,
public/private use, status, elevation, tower type, chart name, NOTAM identifier, and a
runway summary. Runways include dimensions/surface plus `ends[]` joined from
`APT_RWY_END.csv` by site number, facility type, and runway ID. Each end preserves its
identifier, published `trueHeadingDeg`, and `trafficPattern` (`left`/`right`). Blank
headings and pattern flags remain absent; runway numbers are not used as true headings.
Airport `frequencies[]` come from `FRQ.csv`: ATIS/D-ATIS, AWOS/ASOS, Tower, CTAF,
and Ground, with `frequencyMHz`, published `use`, `sector`, `hours`, and `remarks`.
`hours` is the source `TOWER_HRS` text: it describes the tower even when repeated
on an ATIS or Ground record. It is not a service-specific operating schedule.
The join uses the **serviced** FAA identifier, state, country, and facility type,
including AWOS/ASOS records associated with that airport. Ambiguous matches are
omitted. Exact duplicates are removed; distinct sectors and restrictions remain.
UNICOM and approach channels are not substituted for CTAF. Rebuild and upload the
cycle's `nav/` directory to expose frequencies; no chart or plate rebuild is needed.
`fixes.geojson` contains the complete FIX group. VFR waypoints
are additionally written to `vfr-waypoints.geojson`, classified by the FAA's
`FIX_USE_CODE=VFR` field instead of by identifier prefix alone. The FAA specifies VFR
waypoint names beginning with `VP`, but the prefix is not a safe converse test because
some `VP...` identifiers are used for instrument procedures.

`airways.json` has type `ZLayerAirways`. `preferred-routes.json` has type
`ZLayerPreferredRoutes`, cycle/source `metadata`,
and a national `routes[]` array built from `PFR_BASE.csv` and `PFR_SEG.csv`. The
navigation manifest lists it as product `preferred-routes`. Each route's stable
`id` combines its `originId`, `destinationId`, `routeType`, and `routeNumber`, so
multiple routes for an airport pair and the reverse direction remain distinct.
All published PFR types are retained, including TEC, high/low preferred routes,
preferred-direction routes, and North American Routes (NAR). Endpoints use the FAA
identifiers as published; NAR endpoints can be fixes or navigation facilities.

Records preserve the FAA `route` string, TEC `designator`, endpoint city/state/country,
`area`, `altitude`, `aircraft`, `hours`, and `direction` descriptions, plus NAR fields
(`narType`, `inlandFix`, `coastalFix`, `narDestination`). Restrictions remain text:
for example `PQ70` and `J110M90` must not be interpreted as numeric altitudes.
Optional blank fields are omitted. Ordered `segments[]` retain the FAA sequence,
value, type, state/country/ICAO region, NAVAID type, and next-segment value. Routes
without segment records are retained with an empty array; route geometry is not
inferred. Duplicate route identities, duplicate segment sequences, orphan segments,
missing effective dates, and mixed effective cycles fail the build before replacing
the navigation export.

The complete national file can be cached once per cycle for offline airport-pair
lookup. Consumers should map ICAO airport codes to FAA identifiers using the airport
data and display the published conditions alongside each result. The full PFR source
ZIP, including its layout documentation and `PFR_RMT_FMT.csv`, is retained in `nasr/`.

`manifest.json` records the effective cycle, source URLs, source ZIP checksums, output
counts, and classification rule. Existing source ZIPs are reused; the `nav/` output is
replaced atomically only after all groups parse successfully. The current and previous
NASR cycles are retained by default.

Airway `segments[]` preserve FAA `AWY_SEG_GAP_FLAG` as boolean `gap`. Consumers
must not connect across a segment with `gap: true`, or assume connectivity from
`AIRWAY_STRING` alone. Rebuild and upload `nav/` when migrating an older export
without gap flags; this does not require rebuilding any chart imagery.

VOR-family navaids preserve the station's published magnetic alignment as
`stationDeclinationDeg`, from `NAV_BASE.csv` fields `MAG_VARN` and `MAG_VARN_HEMIS`
(east positive, west negative). Missing or invalid values stay absent; a missing
field never means zero variation. Consumers can calculate magnetic radials from
this existing navigation export while offline, without a magnetic-model service.
This field is included automatically by `npm run build:charts` through its normal
NASR stage, and by `npm run build:nav`; it requires no separate build or data product.
Rebuild and publish the complete cycle's `nav/` bundle, including its refreshed
`manifest.json`, when upgrading an older export. The manifest's new `generatedAt`
value versions client URLs; already saved snapshots retain their original data until refreshed.

### Geographic magnetic variation

`npm run build:charts` and `npm run build:nav` also publish
`charts/YYYY-MM-DD/nav/magnetic-model.json`, listed as product `magnetic-model`
in the existing navigation manifest. It contains the global **WMM2025** model
from [NOAA NCEI and the British Geological Survey](https://www.ncei.noaa.gov/products/world-magnetic-model).
Consumers can calculate local magnetic variation from geographic position and date,
including offline. VOR station alignment remains in the navaid records.

The authoritative 4.6 KB `data/WMM2025.COF` is pinned in the repository and
checksum-validated before export. Local `--source-dir` builds include the same
model without network access. It participates in the navigation bundle's existing
staging, atomic replacement, cycle retention, and upload process. No additional
build command, dependency, tile rebuild, or live lookup service is needed.

The JSON contract is `type: "ZLayerMagneticModel"`, `schemaVersion: 1`:

- `effectiveDate` identifies the enclosing FAA cycle. Model validity is separately
  `[validFrom, validUntil)`: **2025-01-01 through 2029-12-31**, with `epoch: 2025`.
  A newer chart edition or rebuild does not extend this interval. Consumers must
  check the evaluation date and avoid presenting an expired model as current.
- `coefficients` contains 90 tuples through degree/order 12. `coefficientFields`
  defines their order: `[n, m, g, h, gDot, hDot]`. Main-field terms are in nT;
  annual changes are in nT/year. Coefficients use Schmidt semi-normalization.
- Evaluate with WGS84 geodetic latitude/longitude, height above the ellipsoid, and
  decimal year. `referenceRadiusKm` is the model's 6371.2 km spherical reference
  radius. This is the complete coefficient model, requiring a WMM evaluator in
  the consumer; the JSON is not a grid of precomputed degree values.
- Resulting declination is east-positive: `magnetic = wrap360(true - declination)`.
  Apply the same local variation to displayed heading, track, and desired course;
  keep route geometry in true coordinates. Consumers should respect WMM's polar
  blackout/caution zones when presenting magnetic bearings.
- `source` records the provider, official download URL, original filename, and
  original coefficient SHA-256. The manifest entry also records the exported JSON
  `bytes` and `sha256`; `count` is the number of coefficient tuples.

To update the model, replace the official coefficient file, its identity/checksum
and validity constants in `lib/magnetic-model.ts`, the published-value tests, and
the third-party notice. Verify against NOAA's release before publishing. Then rebuild
navigation and upload the complete cycle's `nav/` directory; client URLs use the
manifest's refreshed `generatedAt`. See [third-party notices](THIRD_PARTY_NOTICES.md).

To rebuild the complete navigation bundle:

~~~bash
npm run build:nav
~~~

For an offline/local rebuild, provide previously downloaded ZIPs for all eight groups
(APT, FRQ, FIX, NAV, AWY, PFR, DP, and STAR):

~~~bash
npm run build:nav -- --source-dir=/path/to/zips --cycle=YYYY-MM-DD
~~~

`--cycle` is required for local sources and rejected without `--source-dir`.
Online builds always select the current effective FAA cycle. Local builds include
route history only when `--route-history-source` is also supplied.

### Procedures

The procedure builder reads the FAA d-TPP metafile and catalogs every airport record,
including IAPs, airport diagrams, SIDs, charted and textual ODPs, STARs, takeoff and
alternate minima, DVAs, radar minima, hot spots, and uncommon FAA product codes.
Deleted procedures and FAA deletion placeholders are excluded from the current feed.

Each entry has its FAA individual-PDF URL. When a downloaded electronic TPP volume
contains the product, it also has a verified zero-based page index. Shared products
such as takeoff minima are resolved to the first page for that airport. The original
PDF files are read and checksummed but never rewritten.

To use a saved FAA metafile without network access:

~~~bash
npm run build:procedures -- --source-xml=/path/to/d-TPP_Metafile.xml
~~~

The chart downloader selects all 25 combined TPP volumes. The standalone procedure
builder also indexes Pacific procedures in Chart Supplement Pacific. It indexes
whichever volumes are available locally; the nationwide catalog and
individual FAA PDF URLs remain complete even with only a subset of the volume PDFs.

### Chart Supplement airport pages

`npm run build:supplements` indexes airport entries in existing regional books.
It verifies the selected PDFs, FAA XML, and existing catalog before reusing page
indexes; unchanged builds skip directory-page scanning and preserve the catalog.
New or removed books, changed PDFs or XML, and builder-version changes invalidate
the cache. Use `--force` to rescan explicitly. See [docs/procedures.md](docs/procedures.md)
for offline XML input, cycle selection, and the catalog format.

### Historical filed routes

`npm run build:charts` and `npm run build:nav` download Aeronautic AQ's public
`routes.sqlite.zst` snapshot and package `nav/route-history.json.gz` in the current
chart cycle. No account, API key, queue, or separate collection process is needed.
The source download is cached under `dist/route-history/` and refreshed when its
ETag changes. Completed source snapshots are retained because newer versions can
contain less history. Only the compact gzip export goes into `charts/`; geometry blobs and
SQLite indexes stay out of the offline package. Node's built-in zstd support handles
decompression, so no additional package or command-line tool is required.

This is **historical filed-route frequency**, not verified ATC clearance history.
The export preserves the source observation dates, use counts, and engine-class
counts. It includes all filed history available in the selected snapshot; aggregated
counts cannot be turned into a rolling 15- or 30-day sample. A current chart cycle
does not imply current route observations. The snapshot inspected September 16,
2026 had observations through January 27. On September 19, the provider changed
the filed-route label from `f` to `filed` and published a smaller snapshot selected
by recent `last_seen` dates. Both labels are supported; older snapshots remain
available locally and are not merged into the current export. See
[docs/route-history.md](docs/route-history.md) for the format and source changes.

Local NASR builds stay offline. To include history with `--source-dir`, supply a
previously downloaded SQLite or zstd-compressed SQLite file:

~~~bash
npm run build:nav -- --source-dir=/path/to/zips --cycle=YYYY-MM-DD --route-history-source=/path/to/routes.sqlite.zst
~~~

Without that option, local builds omit history. Normal online builds fail on source
or data errors before replacing `nav/`, preserving the previously published files.

## Repository layout

~~~text
build-far.ts          FAR source/build entry point
build-chart-manifests.ts  Chart build-receipt verification and manifest entry point
build-procedures.ts   d-TPP catalog and combined-volume page-index entry point
download-aim.ts       AIM mirror entry point
download-charts.ts    Chart download and MBTiles entry point
download-nasr.ts      NASR download and normalized navigation-data entry point
cfr-ecfr.xsl           FAR XML-to-HTML source template
lib/                   FAR parsing, transformation, site, and PWA modules
test/                  Automated tests
dist/                  Generated products; ignored by Git
~~~

## Development

Run the normal validation commands before making a commit:

~~~bash
npm run check
npm test
git diff --check
~~~

Build outputs, chart archives, and downloaded chart data are intentionally not committed. The source repository contains the builders, templates, tests, and configuration needed to reproduce them.

## Troubleshooting

xsltproc: command not found

- Install/provide libxslt and ensure xsltproc is on PATH.

GDAL driver error for WebP or MBTiles

- Install GDAL with WebP and MBTiles support.
- Confirm with gdalinfo --formats.

FAR part pages return 404 after deployment

- Upload the complete dist/far/ directory, including far-parts/, vendor/, the manifest, service worker, and icons.

The AIM service worker does not install

- Serve dist/aim/ through localhost or HTTPS. Service workers do not install from file:// URLs.

Network or DNS errors

- Retry the build, or use FAR --source-xml mode with a local XML snapshot.
