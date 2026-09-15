# FAA Downloader

FAA Downloader is a collection of build tools for creating local, offline-friendly copies of FAA reference material:

- FAR: a responsive, searchable PWA generated from Title 14 CFR data.
- AIM: a local mirror of the FAA Aeronautical Information Manual HTML site.
- Charts: a downloader and GDAL-based tiler for current FAA aeronautical charts,
  plus map-ready NASR navigation data and a d-TPP procedure catalog.

The generated data is intended for personal reference and offline use. It is not an official FAA publication and should not replace current FAA source material, notices, or operational requirements.

## What it builds

| Command | Product | Output |
| --- | --- | --- |
| npm run build | FAR PWA from the current eCFR snapshot | dist/far/ |
| npm run build:aim | Offline-capable AIM mirror | dist/aim/ |
| npm run build:charts | Current charts, MBTiles, NASR data, and procedure metadata | dist/charts/, dist/zips/ |
| npm run build:chart-manifests | Verify chart build receipts and refresh cycle manifests | dist/charts/YYYY-MM-DD/chart-manifest.json |
| npm run build:nasr | Current NASR airports, fixes, VFR waypoints, NAVAIDs, and airways | dist/charts/YYYY-MM-DD/nav/, dist/charts/YYYY-MM-DD/nasr/ |
| npm run build:procedures | Current airport/procedure catalog and combined-TPP page index | dist/charts/YYYY-MM-DD/tpp/ |

Run only the product you need, or build them into the shared dist/ directory.

## Data sources

- FAR current snapshots: [eCFR](https://www.ecfr.gov/)
- FAR annual editions: [GovInfo CFR collection](https://www.govinfo.gov/app/collection/cfr)
- AIM: [FAA AIM HTML publication](https://www.faa.gov/air_traffic/publications/atpubs/aim_html/)
- Charts: [FAA Aeronautical Information Services](https://aeronav.faa.gov/)
- Airports/navigation: [FAA 28-day NASR Subscription](https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/)
- Procedures: [FAA digital TPP](https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/dtpp/)

The source date and scope are written into the generated FAR interface. Chart downloads are selected from the latest available FAA directory entries. A configured region absent from an FAA listing produces a warning; a listed file that fails to download aborts the build rather than publishing a silently incomplete collection.

FAA chart GeoTIFFs contain the entire printed sheet, including collars, legends, and
insets that are not part of the accurately georeferenced main chart. The chart builder
clips every configured VFR and IFR raster to a reviewed geographic neatline before
reprojection and MBTiles generation. The sectional, TAC, and IFR cutlines are adapted
from the MIT-licensed [N129BZ/chartmaker](https://github.com/N129BZ/chartmaker)
project; the flyway neatlines were measured against the FAA 2026-09-03 rasters. A new
VFR or IFR raster intentionally fails tiling until its cutline is reviewed and added.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the retained license notice.

## Quick start

Requirements:

- Node.js 20.16 or newer
- npm
- unzip on PATH for safe archive validation and extraction
- xsltproc on PATH for FAR generation
- GDAL CLI tools on PATH for chart tiling: gdalinfo, gdal_translate, gdalwarp, and gdaladdo

Install dependencies and run the checks:

~~~bash
npm ci
npm run check
npm test
~~~

Build a product:

~~~bash
npm run build          # FAR PWA
npm run build:aim      # AIM mirror
npm run build:charts   # FAA charts, MBTiles, NASR data, and procedure metadata
npm run build:chart-manifests # Verify and refresh chart manifests only
npm run build:nasr     # NASR navigation data without rebuilding chart imagery
npm run build:procedures # Procedure metadata only
~~~

On NixOS, the external command-line prerequisites can be provided with:

~~~bash
nix-shell -p libxslt gdal unzip
~~~

## FAR PWA

npm run build fetches the current eCFR XML for Title 14, filters it to the configured volumes and parts, and generates a split FAR site under dist/far/.

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
npm run build -- --source=ecfr --vols=1,2,3
npm run build -- --source=annual --year=2025
npm run build -- --source-xml=combined-ecfr.xml --date=2026-04-30
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

npm run build:charts discovers the latest available FAA editions, downloads PDFs and ZIP archives, extracts the required GeoTIFFs, creates WebP MBTiles for raster charts, and builds the current NASR and d-TPP metadata.

Downloads run four at a time by default, stream to `.part` files, report progress, and
resume after interruption when the FAA server supports byte ranges. Tune the shared
chart and NASR download limit when needed:

~~~bash
npm run build:charts -- --concurrency=8
~~~

This repository is also the build and maintenance source for the chart artifacts
published at `https://charts.tedyin.com/charts/`. Downstream applications such as
ZLayers should consume those published artifacts together with explicit FAA edition and
build provenance rather than treating the site as an unrelated third-party source.

Output is organized by publication date:

~~~text
dist/
├── charts/
│   └── YYYY-MM-DD/
│       ├── *.pdf
│       ├── *.tif
│       ├── *.mbtiles
│       ├── *.mbtiles.build.json
│       ├── chart-manifest.json
│       ├── nav/
│       │   ├── airports.geojson
│       │   ├── fixes.geojson
│       │   ├── vfr-waypoints.geojson
│       │   ├── navaids.geojson
│       │   ├── airways.json
│       │   └── manifest.json
│       ├── nasr/
│       │   └── *_CSV.zip
│       └── tpp/
│           ├── catalog.json
│           └── manifest.json
└── zips/
    └── YYYY-MM-DD/
        └── *.zip
~~~

Downloaded PDFs and ZIP files are reused on subsequent runs. Each MBTiles file has a build receipt containing source, output, and tiler-configuration hashes; cached tiles are reused only while that receipt still matches. Generated chart data is ignored by Git because a complete collection is several gigabytes. The chart builder currently produces the download and tile data; it does not provide a chart-viewer PWA.

To tile one existing TIFF without downloading anything:

~~~bash
npm run tile:chart -- --tile=dist/charts/YYYY-MM-DD/chart.tif
~~~

Add `--force` to rebuild an existing MBTiles file. Rebuilds are staged and replaced
atomically, so the previous chart remains usable if GDAL fails. The original FAA PDF
and GeoTIFF stay unchanged; MBTiles are static display derivatives.

The TypeScript tiler clips charts to reviewed geographic neatlines, expands palette
imagery when necessary, uses Lanczos reprojection and overview sampling, writes
quality-92 WebP MBTiles, and builds every display zoom ahead of publication. Browsers
only read and cache these static artifacts; the hosting server performs no chart
rendering. Overview levels extend through factor 128 so high-density clients can retain
2× chart sampling at the widest supported map view.

### NASR airports and navigation data

The chart build also downloads the FAA's current 28-day NASR CSV groups for airports
and landing facilities (`APT`), fixes/reporting points/waypoints (`FIX`), NAVAIDs
(`NAV`), and airways (`AWY`). It generates compact GeoJSON for selectable map points
and JSON for airway route/altitude records.

`airports.geojson` includes the FAA location and ICAO identifiers, facility type,
public/private use, status, elevation, tower type, chart name, NOTAM identifier, and a
brief runway summary. `fixes.geojson` contains the complete FIX group. VFR waypoints
are additionally written to `vfr-waypoints.geojson`, classified by the FAA's
`FIX_USE_CODE=VFR` field instead of by identifier prefix alone. The FAA specifies VFR
waypoint names beginning with `VP`, but the prefix is not a safe converse test because
some `VP...` identifiers are used for instrument procedures.

`manifest.json` records the effective cycle, source URLs, source ZIP checksums, output
counts, and classification rule. Existing source ZIPs are reused; the `nav/` output is
replaced atomically only after all groups parse successfully. The current and previous
NASR cycles are retained by default.

To rebuild only NASR data:

~~~bash
npm run build:nasr
~~~

For an offline/local rebuild using previously downloaded group ZIPs:

~~~bash
npm run build:nasr -- --source-dir=/path/to/zips --cycle=YYYY-MM-DD
~~~

### Procedures

The procedure builder reads the FAA d-TPP metafile and catalogs every airport record,
including IAPs, airport diagrams, SIDs, charted and textual ODPs, STARs, takeoff and
alternate minima, DVAs, radar minima, hot spots, and uncommon FAA product codes.

Each entry has its FAA individual-PDF URL. When a downloaded electronic TPP volume
contains the product, it also has a verified zero-based page index. Shared products
such as takeoff minima are resolved to the first page for that airport. The original
PDF files are read and checksummed but never rewritten.

To use a saved FAA metafile without network access:

~~~bash
npm run build:procedures -- --source-xml=/path/to/d-TPP_Metafile.xml
~~~

Only locally available combined TPP volumes are indexed. The nationwide catalog and
individual FAA PDF URLs remain complete when chart downloads cover fewer regions.

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
