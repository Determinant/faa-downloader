# Historical filed-route frequencies

`npm run build:nav` publishes NASR navigation products and historical filed routes
together; `npm run build:charts` runs that same stage. It reads the public Aeronautic AQ snapshot at
<https://aeronautiql.s3.amazonaws.com/databases/routes.sqlite.zst>.
The provider's database listing is <https://aq.aeronautic.ai/api/databases/versions>.

The downloaded zstd file is cached in `dist/route-history/`, keyed by the upstream
ETag. Every online build checks for a new version. Downloads use `If-Match`, including
resumed transfers, to avoid combining versions. Completed source snapshots are
retained: a newer upstream version can contain less history than its predecessor.
A successful export removes only obsolete partial downloads; interrupted downloads
remain resumable, while fully downloaded files that fail validation are removed.
The existing build lock protects the cache through download and cleanup;
concurrent online history builds sharing an output root fail fast and can be retried.
Decompressed SQLite files are temporary. Custom `--output` roots move the cache
along with the chart output.

The public product is a single gzip-compressed JSON file:

```text
dist/charts/YYYY-MM-DD/nav/route-history.json.<SHA256>.gz
```

Resolve the filename through `nav/manifest.json`; it appears there as `route-history`, with `compression: "gzip"`,
`count` (directional endpoint pairs), `routeCount`, compressed `bytes`,
`uncompressedBytes`, `source`, and `observationRange`. Consumers should download
and cache the compressed bytes and decompress them as gzip before parsing JSON.
This needs no browser SQLite reader. The source SQLite is not published under
`charts/`.

The snapshot inspected on September 16, 2026 was 93.0 MB compressed / 309.9 MB
SQLite. Its export is 9.04 MB gzip / 67.6 MB JSON, with 397,685 routes across
197,421 directional pairs. Sizes will change with later source snapshots.

The decompressed document has this shape (example abbreviated):

```json
{
  "type": "ZLayerRouteHistory",
  "version": 1,
  "effectiveDate": "2026-09-03",
  "source": {
    "name": "Aeronautic AQ",
    "url": "https://aq.aeronautic.ai/",
    "downloadUrl": "https://aeronautiql.s3.amazonaws.com/databases/routes.sqlite.zst",
    "etag": "\"upstream-etag\"",
    "lastModified": "2026-02-13T21:38:12.000Z",
    "sha256": "SHA-256 of the uncompressed source SQLite"
  },
  "countBasis": "source-filed-route-use-count",
  "observationRange": { "firstSeen": "2025-02-14", "lastSeen": "2026-01-27" },
  "pairs": [{
    "origin": "KSBA",
    "destination": "KSMO",
    "totalCount": 144,
    "routes": [{
      "route": "KSBA KSMO",
      "count": 114,
      "engineCounts": { "Piston": 75, "Unknown": 39 },
      "firstSeen": "2025-05-08",
      "lastSeen": "2026-01-25"
    }]
  }]
}
```

- Only positive `use_count` records with `route_type = 'f'`
  or `route_type = 'filed'` from `sfdps_routes_by_type` are included. Preferred
  records (`p` / `preferred`) are excluded; current
  FAA preferred/TEC routes remain in `preferred-routes.json`.
- Identical route strings within a directional pair are grouped across engine
  classes. `count` sums source use counts; `engineCounts` retains the breakdown.
  Empty/missing engine classes become `Unknown`. These are not independently
  verified distinct-flight or ATC-clearance counts.
- `totalCount` sums **all** exported routes for that pair. Use it as the denominator
  for relative frequency; do not divide by only the displayed top few routes.
  For an engine filter, sum that engine's counts across all routes instead.
- Pairs are sorted by endpoint; routes are sorted by descending count, then route
  string. Endpoints and route strings are preserved as supplied. Some source
  endpoints are fixes or coordinates; consumers should match airport identifiers
  using NASR aliases, rather than assuming every endpoint is an ICAO airport.
- First/last observation dates are UTC calendar days. They describe the source
  history, not a fixed observation window or continuous coverage. `effectiveDate`
  identifies the packaging cycle only. Aggregates cannot yield recent 15/30-day
  counts or prove that a route was cleared by ATC.
- Local `--route-history-source=FILE` accepts `.sqlite` or `.sqlite.zst`, records
  its filename and SQLite hash, and omits unavailable upstream ETag/modified time.
  Combined with `--source-dir`, this rebuilds entirely offline. Without an explicit
  history source, local NASR builds omit this product.

Source/download/schema failures stop an online build before the existing `nav/`
directory is replaced. There is no background collector or credential file.

On September 19, 2026, AQ replaced the legacy snapshot with a new export using
`route_type = 'filed'` instead of `'f'`. The snapshot inspected at 23:25 UTC was
35,383,766 bytes compressed and contained 125,612 filed rows, compared with
434,314 filed rows in the preserved February 13 snapshot (93,023,126 bytes
compressed). Both label formats are supported.

The new `_routes_publish_meta` table declares `window_days = 30` and selects
source summaries whose `last_seen` falls within that window. Its available rows
had last-seen dates September 15–19, despite some first-seen dates reaching back
to February 2025. This is a change in upstream selection, not a complete
replacement for the old history; use counts are still source aggregates, not
verified 30-day flight counts. Each public export reflects one source snapshot.
Retaining older sources does not merge their counts into the current export.
