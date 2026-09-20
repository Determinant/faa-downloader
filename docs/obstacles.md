# Daily obstacles

`build:charts` includes `buildObstacles`; `npm run build:obstacles` runs the same
stage independently. Both use the full [FAA Daily DOF CSV ZIP](https://aeronav.faa.gov/Obst_Data/DAILY_DOF_CSV.ZIP).
The snapshot includes verified and unverified records, including the FAA's limited
coverage outside the US. It covers known obstacles affecting aeronautical charting,
not every physical obstruction. See the [FAA source and format documentation](https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/dailydof/).

```sh
npm run build:obstacles
npm run build:obstacles -- --output=/tmp/obstacle-build --source=/path/to/DAILY_DOF_CSV.ZIP
```

The standalone stage requires Node.js and `unzip`; it does not require chart TIFFs,
GDAL, or a NASR cycle. Local-source builds make no network requests.

## Publication

The public entry point is `charts/obstacles/manifest.json`. It is independent of
the dated chart directories and is excluded from `charts/cycles.json`.

| Manifest field | Meaning |
| --- | --- |
| `schemaVersion` | `1` |
| `generatedAt` | UTC build timestamp; not the FAA data currency |
| `source` | FAA source/page URLs, CSV encoding, and SHA-256 of the source ZIP |
| `source.lastModified`, `source.etag` | Upstream HTTP metadata for the exact downloaded version; omitted for local inputs whose publication time is unknown |
| `source.filename` | Local ZIP basename, when `--source` is used |
| `horizontalDatum` | `WGS84` |
| `dataset.path` | `obstacles-<sha256>.geojson.gz`, relative to the manifest |
| `dataset.format`, `dataset.compression` | `geojson`, `gzip` |
| `dataset.sha256`, `dataset.bytes` | Checksum and size of the compressed artifact |
| `dataset.uncompressedBytes` | UTF-8 GeoJSON size before compression |
| `dataset.count`, `dataset.verifiedCount`, `dataset.unverifiedCount` | Counts of obstacle records, not the sum of grouped structure quantities |
| `dataset.bbox` | `[west, south, east, north]` in decimal degrees |

The data is a GeoJSON `FeatureCollection` of WGS84 points with coordinates in
`[longitude, latitude]` order. Each feature's string `id` is the FAA OAS identifier.
Properties are:

| Property | Meaning |
| --- | --- |
| `verified` | `true` for FAA status `O`, `false` for `U`; unverified data remains explicitly identifiable |
| `country`, `state`, `city` | Trimmed FAA location fields; absent state/city is `null` |
| `structureType`, `quantity` | FAA structure type and integer quantity |
| `heightAglFt` | Integer height above ground in feet; zero is retained |
| `elevationMslFt` | Integer elevation above mean sea level in feet; negative elevations are retained |
| `lightingCode`, `markingCode` | Original FAA codes, including `N` (none) and `U` (unknown) |
| `horizontalAccuracyCode`, `verticalAccuracyCode` | Original accuracy categories, or `null` when absent; `9`/`I` mean unknown |
| `faaStudyNumber` | FAA study identifier, or `null` when absent |
| `actionCode`, `actionDate` | FAA add/change code and Julian action date converted to `YYYY-MM-DD`; the date describes that record's action, not snapshot currency |

## Refresh and failure behavior

Every online run revalidates the source's ETag and Last-Modified metadata. Downloads
and resumed transfers use `If-Match` to pin the source version. ZIPs are cached under
`dist/obstacles/<etag-sha256>.zip`; superseded cached ZIPs are removed after a successful
publication. This cache is not uploaded.

The converter streams the FAA's Windows-1252 CSV into UTF-8 gzip GeoJSON. It validates
archive integrity, required columns, unique OAS identifiers, coordinates, numeric
units, codes, and dates. A malformed record fails the build with its source line
number. Publication happens only after the complete dataset passes validation;
download or conversion failures preserve the previous public directory. Concurrent
obstacle builds sharing an output root are guarded by the existing build-lock helper.

Each run replaces the full snapshot, so removed obstacles disappear without replaying
daily change files. Upload the compressed artifact **before** `manifest.json`, and
retain previously published hashed artifacts for clients holding an older manifest.
The existing chart publisher's data-then-manifest upload covers this directory.
Consumers should resolve `dataset.path` from the manifest, decompress the gzip bytes,
and use `source.lastModified` for source freshness. A successful build does not imply
that FAA has published a newer source that day.
