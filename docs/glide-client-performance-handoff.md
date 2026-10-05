# Glide rendering and delivery handoff

Measurements from 2026-10-03. This is the historical client-prototype handoff,
not physical-device validation. The prototype lives in sibling `../zlayer`.

The publisher successor is now implemented and staged separately: see the
[supported format and repack commands](glide.md#repackage-a-completed-publication)
for shared region inventories, numeric overview, independently compressed detail
blocks and decoder fixtures. ZLayer integration remains separate. The measurements
and recommendations below describe the earlier prototype, not the new wire contract.

## Recommendation

Keep gzip for detailed landing polygons. Add a small precomputed density product
for route overview browsing, generated from the existing qualified polygons.
This removes the most avoidable first-visit transfer, JSON parsing and rasterization
from phones. Smaller spatial detail shards are a possible second step, guided by
physical-phone measurements. A new compression codec alone will not fix the
current granularity problem.

## Implemented in ZLayer

- **Route ±20 NM:** zoom-dependent density shading, not route-wide polygon unions
  or inspection targets. Only files intersecting the visible corridor are eligible.
- **Detailed polygons:** limited to calculated ownship and selected **Show glide
  range** footprints, including a selected landing site's arrival range. Detail
  also works without a route. GPS loss/point clearing removes dependent detail.
- **Shading preparation:** a worker decodes existing validated polygon files and
  rasterizes independent numeric tier grids, up to 512 × 512 one-byte cells each.
  Holes are retained; preferred ground wins overlaps. These are coarse samples,
  so narrow openings can disappear. Shading represents screened-ground density,
  not probability of a successful landing or a verified safe-ground mask.
- **Loading/cache:** two overview summaries acquired per progressive pass; at most
  32 files per view and 64 resident grids. Optional disk caches: 128 summaries /
  16 MiB and 64 original gzip files / 64 MiB. These are cache limits, not a national
  inventory limit. Acquisition/validation admission is bounded to two jobs;
  detailed geometry acquisition itself currently iterates eligible files serially.
- **Detail retention:** 24 shards / 24 MiB of source raw JSON / 300,000 vertices.
  This is input accounting, not a bound on total JS heap or transient allocations.
  The current planner retains visited polygons and omitted-record bounds to avoid
  unrelated redecodes on camera movement. Inspect the latest working tree before editing.
- **Rendering/lifecycle:** roughly 4–8 screen pixels per density cell, at most
  385 cells per axis, nearest-neighbor filtering. Only overlapping source grids
  participate in each cell's union samples. Detail uses MapLibre zoom-dependent
  simplification (tolerance 0.75, max source zoom 16). Unchanged outputs skip
  uploads; camera/hide cancellation, GPS-follow handling and cache reuse remain.
- **Contrast refinement:** green `#53e52d`, purple `#a23bff`; detail fill opacity
  0.62. Thin outlines remain 0.75 px over a 1.5 px dark casing (opacity 0.75).
  Nonempty density alpha is `64 + 160 * sqrt(coveredSamples / 16)`; empty
  cells remain transparent. Each density cell uses its
  predominant tier (purple on a tie), rather than a washed-out interpolated hue.
  The legend/arrival purple match. Palette changes do not invalidate numeric grids.

## Measurements and limits

Real published schema-8 polygons, Santa Barbara view, desktop Chromium with files
served locally; independent 1280×900 and 393×852 viewport contexts. Timings include
UI/worker/cache setup and debounce. Phone-sized viewport **does not simulate phone
CPU, RAM, cellular latency, thermal throttling or battery consumption**.

| Measurement | Observed |
| --- | --- |
| Cold overview | 704 ms desktop viewport; 628 ms phone viewport |
| Source transfer | 2 gzip files, 2,417,834 bytes (2.31 MiB), excluding manifest |
| Cached disable/re-enable | 341–377 ms; no additional shard downloads |
| Full page reload with cache | 685–767 ms; zero new shard downloads |
| Two derived grids, raw | 359,520 bytes (351 KiB) |
| Same two grids compressed with gzip | **10,123 bytes (9.9 KiB)** |
| Shading image | 280×197 / 220,640 bytes desktop; 87×186 / 64,728 bytes phone |
| Selected-range detail | Approximately 105 patches / 14,533 vertices; no new source downloads after overview |

The summary-versus-polygon payload ratio is approximately **239× for this sample**,
excluding manifest/index overhead. This is an opportunity estimate: overview files
are not yet published. It is not a national size/speed guarantee. Selected-range
checks used real polygons with **synthetic flat terrain** to isolate rendering.
The numerical timings above precede the final color/opacity refinement; that
refinement preserves grid dimensions, acquisition and polygon budgets.

Published dataset checked: `dist/charts/glide/manifest.json`, generated
`2026-10-03T20:21:21.109Z`, schema 8, 2,798 shards, 3,636.93 MiB compressed total.
Median shard: 1.50 MiB gzip → 7.34 MiB raw JSON; 95th percentile approximately
1.80 MiB gzip / 7.99 MiB JSON. Manifest: 886,325 bytes; an offline gzip experiment
produced 246,795 bytes (this does not establish the production HTTP encoding).

The first visit still downloads, authenticates, decompresses and parses **every
selected shard in full**, including off-screen polygons inside that shard. JSON
arrays and projected geometry add memory beyond raw byte counts. A cached gzip
file saves network traffic but still needs validation/decoding when decoded detail
is absent; cached numeric summaries avoid that work for overview browsing.
Zoom-dependent drawing currently does not reduce source-file resolution or size.
A worker protects main-thread responsiveness, not the device's total CPU/battery.

Gzip supports the existing independently compressed spatial shards. It does not
provide arbitrary spatial/random access inside one file; the current loader also
requires whole-file SHA-256 and complete JSON validation. HTTP Range alone cannot
make a substring of these gzip JSON arrays an independently usable polygon tile.
See [RFC 1952 §1.1](https://www.rfc-editor.org/info/rfc1952/#section-1).

## Suggested next publisher work — not implemented

1. Add a companion overview manifest and compact **numeric** density artifacts,
   initially derived from the same validated published polygons. Leave existing
   detail files readable. Building summaries needs a packaging pass, not renewed
   terrain/vegetation/obstacle screening.
2. Define and test the overview contract: projection/georeferencing, resolution,
   source/algorithm identity, tier/union meaning, compressed/raw bounds, hashes,
   flags and preparation coverage. Preserve unknown/unprepared status; zero density
   must not mean verified unsafe or assessed ground. Keep colors in the client.
3. Prototype the current per-shard grids first, then choose spatial tiling and
   zoom levels based on measured payload/aggregation quality. Do not freeze the
   current nearest-tier sample representation as a final multiresolution density
   contract without testing area preservation, overlap, holes and tiny openings.
   A pyramid must aggregate coverage meaningfully, not just average tier numbers.
4. Teach ZLayer to acquire published summaries through core's bounded cache,
   with a fallback for the existing feed. Validate/cache each complete identity;
   publish artifacts before atomically replacing their manifest.
5. Profile first-visit overview, warm pan/zoom and sustained moving-ownship detail
   on physical iOS/Android devices: bytes, time-to-first/useful coverage, CPU,
   peak memory, frame-time distribution and sustained power/thermal behavior.
6. If detail remains costly, spatially repack into smaller whole-polygon shards
   and/or evaluate indexed binary geometry. Preserve original IDs, measured fit,
   flags and holes; splitting/clipping geometry must not silently attach a fit to
   an unrelated fragment. Packaging identity already exists independently of
   expensive analysis checkpoints. Avoid a wholesale format rewrite without evidence.

## Code and verification entry points

Paths below are relative to this repository unless prefixed with `../zlayer`.

- Publisher: `lib/glide-shards.ts` (bounds, packing policy, validation),
  `lib/glide-assembly.ts` (checkpoint/publication), `docs/glide.md`.
- Client: `../zlayer/src/layers/glide/landing-display.ts` (overview orchestration),
  `landing-heat.ts` (grids/composition), `landing-loader.ts` (verified source and
  derived caches), `landing-planner.ts` (detail selection/clipping/inspection),
  `landing-map.ts` (map layers/lifecycle), `map.ts` and `plugin.tsx` (range handoff).
  Owning documentation: `../zlayer/src/layers/glide/README.md`.
- Focused tests: `../zlayer/test/glide-landing-display.test.ts`,
  `glide-landings.test.ts`, `glide-landing-geometry.test.ts`, and
  `../zlayer/test/e2e/glide-landings.spec.ts` / `glide.spec.ts`.
- Prior prototype verification passed type/import/theme checks, focused units and
  26 Chromium glide browser tests. Sharpness refinement passed its 7 focused
  density tests and real-data desktop/phone-viewport browser checks. This is not
  a full release verification or a mobile battery certification.
- Final contrast refinement passed type/import/theme checks, the 7 density tests
  and 4 landing-area browser tests. Visual checks used real landing polygons over
  hash-verified 2026-09-03 sectional and IFR-low chart packages around Santa Barbara
  (archived charts used solely as rendering backgrounds). The recent request was
  stronger green/purple visibility while retaining crisp shading and thin outlines.
- Both repositories have substantial unrelated/uncommitted work. Preserve it;
  inspect current code and diffs rather than assuming this dated note is exhaustive.
