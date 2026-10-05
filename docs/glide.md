# Glide landing-area preparation

`build:glide` prepares experimental connected landing-area candidates for the
Glide Planner's **Off-field coverage** overlay. Airport and ownship glide
reachability are separate ZLayer calculations. This build finds ground worth
considering when an airport cannot be reached; it does not calculate reachability
or a probability of a successful landing.

Start with [the strategy](#current-strategy). Use the reference sections for
[exact screening rules](#current-screening-criteria),
[shape simplification](#fit-and-displayed-area), [efficiency](#efficiency),
[build commands](#running-the-builder), [resume behavior](#build-and-cache-behavior)
and [delivery formats](#shared-glide-delivery-v1).

```sh
npm run build:glide
```

The default command acquires its inputs automatically for CONUS. No source JSON
or account setup is required. It publishes the existing polygon feed in
`dist/charts/glide/`, beside `terrain/`, and stages the new shared delivery in
`dist/glide-packages/charts/glide/`. Large preparation inputs stay in
`dist/glide-cache/`. ZLayer integration for the new delivery is a separate task;
the current feed remains readable during that migration.

Engine **v1** is the stable pre-release label (`builderVersion: 1` and
`glide-cache/analysis-v1/`). The shared package delivery schema is **1**; newly
calculated candidate records use schema **9**. These versions are independent.
Analysis uses an explicit cache revision, with no automatic code-hash trigger;
[resume still depends on matching source identities](#source-identity-on-restart).
The screening policy lives in [glide-model.ts](../lib/glide-model.ts).

## Current strategy

Find a straight fit in each connected opening, then display the surrounding
screened ground. The stored **qualification** (or witness) records that fit.

| | Green: preferred ground | Purple: local last resort |
| --- | --- | --- |
| Fit, length × width | At least **2,000 × 200 ft** | Target **1,500 × 100 ft**; retain alternatives down to **600 × 60 ft** |
| Cover | Grass/pasture/crops; canopy ≤5%, impervious 0% | Adds conditional shrub, bare and developed-open cases |
| Terrain | Grade ≤2%; strict relief limits | Gentler ≤6% or broader ≤12% grade; bounded undulation and relief |
| Hazards | Buffered exclusions | Some smaller setbacks; wire buffers and positional uncertainty remain |

1. **Screen cover, terrain, then hazards.** Reject unsuitable or unknown ground
   early; missing required evidence cannot qualify it.
2. **Find each opening's own fit.** Prefer gentler terrain, then wider purple
   fits. Check whole rectangles with bounded heading refinement and early exits.
   Distant better fields never suppress local options. There is no national quota,
   global top-N selection or requirement to produce a candidate in every region.
3. **Display only connected ground in the qualifying terrain band.** Removing
   rougher connections can detach pieces; each must independently qualify again.
   Green qualifies separately and draws above overlapping purple.
4. **Simplify after qualification.** Trim jagged edges and eligible tiny holes
   under full-fit, topology, area and shape checks. The early 10 m pass can bevel
   corners; the later pass pins surviving main shape points. Hazard, rejected-cover
   and unknown-terrain holes stay protected.

Poor nearby alternatives never relax required-data, unresolved-forest or terrain
exclusions, and purple fallback criteria never promote ground into green.

Save completed chunks, then assemble and publish polygons with qualifications,
compromise flags and provenance. These are experimental ground candidates, not
runways or aircraft stopping-distance calculations. Wind, aircraft performance,
approach clearance, actual vegetation and surface condition remain unverified.
Airport infields are included, so patch counts are not counts of independent
off-airport alternatives. Reachability is calculated separately by ZLayer.

## Current screening criteria

### Land cover and vegetation

- Green accepts NLCD grass/herbaceous (71), pasture/hay (81) and cultivated land
  (82), Science TCC canopy **≤5%**, and impervious cover **0%**. Cultivated ground
  is flagged; crop type and seasonal crop height are not classified.
- Purple also considers developed open space (21), bare substrate (31) and
  shrubland (52). More developed classes (22–24) need independent mapped or
  fine-raster open-ground corroboration. Water, wetland, unknown required cover
  and mapped excluded ground remain rejected. Conflicting forest evidence is
  handled only under the narrow corroboration rules below.
- Canopy **>5–20%** and impervious cover **>5–50%** require that corroboration and
  remain purple. Impervious cover **>0–5%** is purple without that extra evidence.
  Nothing above the respective 20%/50% ceilings passes. These are modeled pixel
  fractions, not proof that a particular landing line is free of trees/buildings.
- Positive corroboration comes from mapped grass/open ground or native WorldCover
  grass/crop pixels. Bare/beach evidence additionally needs NLCD bare evidence.
  WorldCover tree and water/wetland/mangrove flags are reduced independently by
  maximum. Water exclusions always win. A mapped beach label alone is insufficient.
- A coarse NLCD forest cell can be recovered only with **both** mapped grass/open
  ground and fine-raster grass/crop evidence, **≤5% canopy**, **≤5% impervious**,
  and no fine-raster or mapped exclusion. An older fine-raster tree classification
  can be recovered only with NLCD grass/pasture/crop, mapped grass/open ground,
  those same low canopy/impervious limits, and strictly newer NLCD, canopy and
  mapped-source dates. Missing dates never establish newer evidence. Both cases
  stay purple with flag **1024**; source dates do not prove an individual mapped
  feature was recently surveyed. Mapped forest/wetland and fine water still win.
- Shrubland needs **both** RCMAP shrub cover and modeled mean height. Nested
  bands are **≤10% / 30 cm**, **≤20% / 50 cm**, and **≤60% / 100 cm**. All shrub
  areas remain purple, even with a long fit; broader bands carry another flag.
  Height is the mean of the shrub-covered portion, not the tallest plant and
  not height multiplied by cover fraction. Missing paired data leaves shrubland
  unassessed. The manifest marks regions without both shrub source families;
  this is a regional availability flag, not a per-pixel completeness claim.

Classify source pixels before reprojection. Reduce eligibility by minimum and
exclusions by maximum, retaining excluded contributors instead of averaging
class codes. Science TCC is the unmasked canopy product: the processed NLCD tree
product masks agricultural land to zero and is unsuitable here. The source models
can still miss individual trees, ditches, rocks, fences, trellises or changed crops.
There is no satellite-image analysis or computer vision in this build.

### Terrain and evenness

The landing analysis uses a **10 m metric grid** and bare-earth DEM source pixels
**≤12 m**, retaining the minimum and maximum contributing elevations. It does not
use the coarser maximum-elevation tiles published for the terrain/glide-range
plugins. Cover products can have native pixels up to 40 m; the automatic cover
products are generally 30 m, with supplemental WorldCover at 10 m.

- Green requires **≤2% neighboring-cell grade**, **≤0.5 m within-cell relief**,
  and **≤2 m total relief over the 3×3 neighborhood**. Grade uses the midpoint
  of each cell's retained elevation interval; relief checks retain its extrema.
- Purple fits a least-squares plane to nine interval midpoints. The gentler band
  allows **≤6% grade / 0.75 m maximum plane residual**; the broader band allows
  **≤12% / 1.5 m**. Thus a steady hillside and an abrupt local break are assessed
  separately. Every contributing neighborhood cell must have known elevation.
- Native extrema remain checked in both purple bands. Let `span` be the sum of
  absolute fitted rises along the two 10 m cell axes, `R` the band's residual
  limit, and `C` its within-cell allowance (**1 m**, then **1.5 m**). Require
  `cellMax − cellMin ≤ C + span` and
  `neighborhoodMax − neighborhoodMin ≤ 2×span + 2×R + C`.
  The plane measures the DEM; it does not smooth or replace those elevations.

This detects modeled landform and relief, not wheel-scale surface smoothness.
No reduction method can retain an obstacle or bump absent from the source DEM.

### Hazards and margins

Distances below are nominal metric buffers before the **1.01 numerical margin**
and all-touched hazard rasterization. Sources can overlap; their excluded-cell
counts must not be added together.

- Identified building footprints: **30 m green / 20 m purple**. Mapped ground
  barriers: **60 m / 10 m**. Untyped building inventories keep **60 m** in both.
- Power, communication and aerialway lines: **60 m in both tiers**, including
  mapped distribution lines. Purple does not remove the wire buffer.
- Water: **30 m / 5 m**. Roads, rail and unknown transport classes: **30 m in
  both**. Typed paths: **10 m / 0 m**; steps retain 10 m. Roads themselves are
  not proposed landing areas.
- Identified ordinary point obstacles: **100 m / 30 m** physical base. This
  includes buildings/control towers, transmission towers, poles, tanks, fences,
  solar arrays, bridges and wind turbines. Cranes retain **150 m**. Generic
  towers, potentially guyed masts and unknown types retain **610 m in both tiers**.
  Mapped crane tags are preserved even when their generic class differs.
- Point-obstacle clearance is at least **1.5 × AGL height**, then adds the full
  reported positional allowance in both tiers. Without supplied accuracy,
  identified mapped sources use **30 m** and FAA/unspecified sources use **1 NM**.
  The latter is a screening assumption for unknown accuracy, not a measured bound.
  Purple no longer caps reported uncertainty or substitutes a small mast buffer.
  Its reduced-obstacle flag still identifies the smaller ordinary-structure base.
- Buffers over **10 km** fail explicitly; they are never silently truncated.
  Source-query coverage extends **12 km** beyond ownership bounds. Detailed
  analysis uses a **1.6 km halo**, including hazards outside the chunk whose
  buffers reach its grid.

Mapped wetlands, glaciers, scree, reefs and excluded land-use polygons also
block ground. Their mapped boundaries and completeness can be wrong; absence
from a layer is not evidence of absence on the ground.

### Fit and displayed area

Four-connected eligible cells form patches; touching only at a corner does not
join them. The optimistic size precheck may admit more possibilities, but cannot
approve any landing. Final search checks the **whole oriented footprint**, not
just its centerline or axis-aligned bounding box. It tries the component's
principal direction, cardinal directions, 10° heading steps and local 2°/4°
refinements. Parallel lines are sampled every 5 m and runs every 10 m.

Within each purple patch, search gentler terrain at 100 ft, then 60 ft width,
followed by the broader terrain at those widths. Among inspected fits, score
`min(lengthFt, 1500) × sqrt(widthFt)`, divided by 1.3 for the broader terrain band.
Stop at a target-sized fit in an earlier preference. This ranks inspected options;
it is neither an exhaustive optimum nor a landing-success score. The efficiency
changes retain the **5 m** line spacing; the older 100 ft spacing is not in use.

There is no extra operational end reserve (`endClearanceFt = 0`). A 1% numerical
margin and 2 m numerical end allowance remain. Green adds 10 m cover-boundary
clearance around the fit; purple can use zero extra cover clearance and flags
that compromise. Hazard buffers remain separate. The inspected straight run is
capped at 2,000 m; the saved witness need not be the longest possible fit.

Each witness also retains its overall along/across grade, fitted to the existing
DEM interval midpoints within the inspected footprint. This adds no raster pass.
It is rounded to 0.1 percentage point and shown on inspection. It is not a maximum
local slope, recommended approach direction, or aircraft stopping calculation;
the local grade, residual and elevation-extrema checks still apply.

After qualification, polygonize connected ground and preserve a contained
qualification. Apply a 1 m inward buffer, then apply the practical early
**10 m topology-preserving simplification**, clipped to that inset geometry.
Accept only a valid single polygon retaining the complete qualification and
losing at most **2% of its input area**; otherwise keep the inset input. Compute
the candidate once in a materialized SQL query before checking it. This reduces
raster stair steps before exporting vertices to JavaScript. It can bevel corners
within the tolerance; exact preservation of every original corner is not required.

The following local display pass marks shape anchors on this generalized input.
Compact holes of at most **2,500 m² / 80 m span** may be omitted within a cumulative **2% area** budget
only when their bounding boxes contain no hazard, rejected cover, unknown DEM
or terrain that fails both purple bands. Small holes on otherwise eligible
terrain may disappear; a failed terrain cell keeps its hole visible.

Pin the outer boundary's north/south/east/west extent points and persistent turns
of **30° or more**, looking **80 m along the original boundary** on each side.
Also pin shallow corners of at least 1° between straight reaches, allowing 25 cm
of coordinate noise. These anchors protect broad bends, narrow-arm tips and
connection mouths even when their area is small relative to the whole region.

Only short inward shortcuts may change the remaining boundary. A changed edge
must span **at most 80 m** and stay within **15 m** of every skipped original
vertex. Exactly collinear vertices may be removed over longer straight runs.
Larger or long narrow holes keep their outlines from the early pass; only compact
holes within the **2,500 m² / 80 m** limits receive local outline simplification. These
shortcuts enlarge exclusions rather than fill them; cosmetic hole removal uses
the separate evidence checks above. Smaller holes and then the outer boundary
share a **2% removed-area budget**. Work per ring is bounded.

Accept only a valid single polygon inside the hole-filtered input, with the
full original witness retained and at most 2% net area change relative to this
pass's input. A rejected candidate retains the input. The two reduction passes
have separate 2% limits; the local pass preserves the anchors left by the early
10 m generalization instead of imposing exact original-vertex preservation.
Each SQL candidate is materialized once. Geometry checks use metric coordinates;
GeoJSON exports round to six decimal degrees. The displayed fill
is a generalized candidate area; it is not a clearance mask or evidence that
all points/headings within it qualify. See
[glide-areas.ts](../lib/glide-areas.ts) and
[glide-display.ts](../lib/glide-display.ts).

### Efficiency

The screening optimizations retain fit dimensions, terrain bands, hazard setbacks,
heading order, **5 m line spacing** and early exits:

- Skip rectangle lookup construction when no component can qualify. Omit a
  duplicate zero-margin cover check only after proving the fit mask already has
  known eligible cover; positive margins and inconsistent masks keep that check.
- When terrain masks are identical, share their lookup and skip the repeated
  lower-ranked search. Lazily reuse raw centerline runs across widths for the
  same component, mask and heading, with a bounded cache; every width still gets
  its exact footprint check.
- Skip components wholly outside chunk ownership. Preserve complete crossing
  components and their halo. The longest-run diagnostic excludes wholly external
  components.
- Buffer features with equal green/purple clearances once for both masks.
  Different clearances retain separate evaluations. Mixed sources use three
  raster passes to avoid duplicate geometry buffering; that tradeoff is not a
  universal speedup. Constant differing setbacks, including building footprints,
  still use two passes. Source loss counts measure the union of overlapping subsets.
- Compute each polygon-reduction candidate once in materialized SQL. Early
  outline reduction saves later vertex work under the shape checks above.

The [historical display benchmark](#geometry-performance-check) measures one
geometry stage only. There is no controlled national measurement establishing
a 2× overall speedup. Measure fresh chunks separately from cache hits; regional
complexity, source acquisition and final assembly all affect elapsed time.

Display generation currently shares the analysis checkpoint. Code-only display
changes take effect for newly calculated chunks; use `--rebuild` or deliberately
bump the analysis revision to regenerate all outlines. Display rule changes also
invalidate analysis unless an exact compatibility migration is provided. Existing
publications and exact repackaging do not change until explicitly rebuilt.
A future separation of qualified-ground checkpoints from
display generation would make visual tuning cheaper; it must retain the source
exclusion masks needed to decide which holes may be filled.

## Processing flow and automatic inputs

1. Discover source versions and regional coverage. Classify cover first and run
   an optimistic regional presence check, including analysis halos. Empty regions
   skip later acquisition. Normal CONUS selection currently has 1,107 regions;
   `--estimate` reports the actual selected count without downloading inputs.
2. Assemble native cover/canopy/impervious evidence and optional corroboration.
   Reject chunks whose connected cover cannot possibly fit the purple minimum.
3. Reduce precision DEM to minima/maxima, calculate terrain bands once, and run
   another necessary size check. Rejected chunks skip hazard acquisition.
4. Acquire/validate hazards once per surviving region. Apply their buffered masks
   to the already computed surface, then search green and purple fits.
5. Save each completed chunk and diagnostics atomically. Polygonize and generalize
   qualified connected ground; candidate-center ownership prevents neighboring
   chunks from owning the same fit.
6. Merge compatible candidate patches in bounded batches, partition delivery
   files as needed, validate source identities again and atomically publish the
   manifest. Only compact geometry, flags and metadata are delivered.

Automatic source families:

- **USGS 3DEP 1/3-arc-second DEM:** catalog-discovered native-pixel windows,
  pinned with source identities. Metadata must declare metres and a
  non-ellipsoidal vertical datum. Missing precision coverage stays unassessed.
- **Annual NLCD cover/impervious:** latest discovered numerical MRLC WCS layers,
  native aligned 30 m subsets. XML/HTML error responses with HTTP 200 are retried
  and then fail; they cannot become empty or eligible ground.
- **USFS Science TCC:** unmasked numeric canopy cover, locked source raster,
  native aligned 30 m windows with rendering disabled.
- **RCMAP shrub cover/height:** paired latest-year numerical subsets where shrub
  evidence is needed. The service supplies 30 m Web Mercator pixels. Outside its
  western footprint it cannot approve shrubland.
- **ESA WorldCover 2021 v200:** native 10 m COG subsets for open-ground
  corroboration and independent tree/water/wetland exclusions. Its age remains
  a source limitation, even when newer NLCD agrees.
- **Overture:** a pinned release of buildings, water, road/rail, power and other
  infrastructure, obstacles, land use and selected `land` features. Ground
  positives include mapped grass/open uses and beaches; explicit exclusions win.
  Display-generalized `land_cover` polygons are not used as tree evidence.
- **FAA Daily DOF:** reuse the ordinary obstacle downloader's ZIP and prepared
  snapshot in `obstacles/` and `charts/obstacles/`. Glide builds a derived spatial
  index keyed by that snapshot, rather than downloading/converting DOF twice.

Successful empty vector queries are valid; failed or skipped required queries
cannot approve candidates. Vector subsets stream through indexed GeoPackages and
GeoJSONSeq instead of loading an entire regional feature collection into memory.
Source attributions, dates, identities and interpretations are retained in
published provenance; local file paths are omitted.

MRLC/RCMAP `GetCoverage` requests retry HTTP 404 up to **three attempts**, waiting
**5 then 10 seconds**. A 404 from these dynamically generated subsets can be
temporary; it does not by itself establish rate limiting (HTTP 429). A persistent
404 still stops acquisition and is never cached as missing/clear cover. Ordinary
file downloads retain their existing 404 behavior. This retry change preserves
source identities and completed analysis checkpoints.

## Running the builder

Requires **Node 24** and **GDAL 3.11+** with GeoTIFF, ENVI, GeoJSON/GeoJSONSeq,
GeoPackage, SQLite SQL and GEOS. DuckDB downloads its signed HTTP/spatial
extensions into the preparation cache on first use.

```sh
npm run build:glide
npm run build:glide -- --estimate
npm run build:glide -- --bbox=-122.1,38.0,-122.0,38.1 --output=dist/glide-trial
npm run build:glide -- --concurrency=16 --region-concurrency=8
npm run build:glide -- --assembly-concurrency=8
```

`--bbox=west,south,east,north` replaces the selected output's published coverage,
so use a separate output for trials. `--rebuild` repeats analysis with cached
sources; `--refresh-sources` reacquires cover/map subsets, including provider
corrections that retain the same release metadata. Neither is needed to resume
an interrupted build or apply a packaging-only fix.

To pick up compatible performance improvements during a run, stop it with Ctrl+C,
wait for it to exit, then rerun `npm run build:glide` with the same output and
coverage arguments, without `--rebuild` or `--refresh-sources`. Verified completed
chunks with matching source identities are reused; unfinished chunks and temporary
preparation may repeat. Automatic source discovery still runs on restart; see
[the source-snapshot limitation](#source-identity-on-restart) before assuming that
all prior analysis will be reusable.
Keep `dist/glide-cache/`. The October 3 optimization migration also accepts the
known preceding run's receipts and cover prechecks after verifying their exact
inputs and output checksums. Reused chunks keep their existing outlines; newly
calculated chunks use the restored early outline simplification.

The new shared delivery must stay **below 5,000,000,000 bytes**, counting its
complete active graph, discovery and pinned snapshot. `--max-bytes=BYTES` can
tighten that limit. The legacy assembly feed retains its optional aggregate cap,
2 MiB compressed / 16 MiB raw shard caps and 10,000-shard limit. Exceeding a
stage's budget retains that stage's previous publication and completed caches.
Preparation disk use and retained generations are separate and can be much larger.

Use `--packages-output=ROOT` to select another staging root, or `--skip-packaging`
to stop after the legacy feed and frozen analysis snapshot. These options do not
change screening keys. For a completed older publication, use the command below
to avoid source acquisition and analysis altogether.

## Repackage a completed publication

Requires Node 24; the default repack does not need GDAL or original source data.
The selected publication must include its manifest, provenance and all referenced
gzip shards. Both record schemas 8 and 9 are supported, irrespective of the
current engine version, rules or analysis implementation.

```sh
npm run build:glide-packages -- \
  --input=dist/charts/glide/manifest.json \
  --output=dist/glide-packaging-test

npm run build:glide-packages -- \
  --verify --output=dist/glide-packaging-test
```

Output is `dist/glide-packaging-test/charts/glide/`. Input and output locations
must be separate. The command first copies and verifies a pinned input under
`OUTPUT/glide-package-cache/inputs/<manifest-sha>/`. Subsequent edits to original
files cannot affect that snapshot. The input manifest remains untouched.

Repacking preserves every coordinate delta, ring/hole, qualification, elevation,
available slope, flag, tier and multiplicity exactly as stored. Original IDs
remain `sourceShardSha256:recordIndex`. It does not clip at tile/state boundaries,
merge, simplify, reproject or requantize detail. Existing generalization cannot be
recovered from an already published feed. Numeric overview is an approximation.

Rerun the same command to resume interrupted work or repair missing outputs.
Verified detail blocks, overview masks and density tiles are reusable checkpoints.
Their identities include the shared chart tile-grid implementation, so grid changes
invalidate affected payloads without invalidating analysis.
`--force-packaging` regenerates those outputs using the same pinned geometry;
it never reruns analysis or assembly. `--concurrency=1..8` controls packaging
workers (default 4). There is no `--rebuild` fallback: missing, corrupt,
unsupported or incomplete input fails explicitly.

`--regions=FILE` accepts the existing offline region format, an array of
`{id,title,bounds:[[west,south,east,north],...]}`. Default definitions come from
`data/terrain-regions.json`. Use split rectangles around the date line. Region
changes reuse the same encoded payloads. `--overview-zoom=10|11` selects the
finest density level; compare runs using the same input and cache to reuse detail.

Each run writes `OUTPUT/glide-package-cache/report.json`: source/snapshot hashes,
active and retained bytes, component totals, block size/complexity percentiles,
overview levels, large singletons, exact-detail digest, and stage counts including
zero downloads and zero analyzed chunks. This report stays outside the delivery.
The digest hashes each source's ordered `[originalId, tuple]` lines, then hashes
the source digest strings in input-manifest order. Exact equality is checked
against the input while encoding and reusing blocks; `--verify` independently
checks the final delivery graph, hashes, decoded bounds/counts and ID uniqueness.

### Resume an interrupted assembly

```sh
npm run build:glide -- --assembly-only --skip-packaging --assembly-concurrency=8
```

This resumes merge/gzip assembly and publishes `dist/charts/glide/manifest.json`.
It reads saved analysis and assembly checkpoints without discovering sources,
checking original source files, downloading inputs, or running screening. Completed
groups and gzip batches are reused. Omit `--skip-packaging` to run the new delivery
packaging pass after assembly. Use `--output=ROOT` if the original build used a
different output root. Stop an existing builder before resuming in the same root.

Normal builds now save `glide-cache/assembly-input.json` **before** assembly starts,
including provenance, exact chunk references and spool hashes. A saved group can
then resume without parsing its original polygons. Missing or corrupt required
analysis stops this mode; it never falls back to downloads or screening.

For completed runs from before that inventory existed, the first assembly-only
invocation adopts the saved `analysis-v1/area-chunks/` and `ground-rejections/`
receipts. It requires exactly one checkpoint for every chunk of each included
region, checks polygon bytes against their receipts, and pins the selected inputs.
For an older custom/bounded run, supply the original `--sources=FILE` or `--bbox` on
that first invocation; subsequent resumes use the pinned inventory. Regions with
no checkpoints remain unassessed. This older-run recovery records that historical
per-region source associations were not retained; it does not invent source
provenance or export a complete historical frozen snapshot. It can still publish
and package the recovered polygons. Keep the selected cache files until assembly
finishes. `--rebuild`, `--refresh-sources`, `--estimate`, `--concurrency`, and
`--region-concurrency` cannot be combined with this mode.

### Test final assembly without screening

For an interrupted build with a pinned `glide-cache/assembly-input.json`, inspect
every remaining assembly batch and collect all failures in one pass:

```sh
npm run audit:glide-assembly -- --assembly-concurrency=8
```

This uses the production assembler, saves successful gzip/group checkpoints for
the next resume, and writes `glide-cache/assembly-audit.json`. It does not publish
a manifest or read/download source assets. A failed batch does not prevent later
batches or groups from being checked, and a group with any failure never gets a
completion receipt. Exit status is nonzero if the report contains failures.
Existing completed groups are reused after their artifact hashes are checked.
Use `--output=ROOT` to select a different saved build.

### Rebuild selected chunks from cached sources

When exact per-region source metadata is available, a targeted plan can replay
specific analysis chunks and retain the rest of the assembly inventory:

```sh
node --import=tsx tools/glide-rebuild-chunks.ts --plan=dist/glide-cache/targeted-rebuild/plan.json --concurrency=16
npm run build:glide -- --assembly-only --skip-packaging --assembly-concurrency=16
```

The plan contains `schemaVersion: 1`, the pinned manifest's `inputSha256`, selected
chunk IDs in `chunks`, and resolved source `regions`. Every selected chunk's
historical source fingerprint must match, and source bytes are verified before
analysis. This command never discovers or downloads sources. Missing metadata
must be reconstructed and fingerprint-verified first; directory names alone do
not establish which inputs produced a chunk.

Results are staged with receipts. Every original fit and its flags must survive,
and every replacement polygon must pass validation. Only after all selected
chunks succeed does the tool replace the pinned inventory and refresh the normal
analysis cache. The prior inventory and changed analysis files are backed up under
`glide-cache/targeted-rebuild/`. Assembly then reuses unaffected groups and batches.

Normal analysis builds now export a complete immutable snapshot and
`glide-cache/frozen/latest.json`, enumerating qualified original chunk patches,
verified empty chunks, historical rules/provenance and a frozen assembly baseline.
Select an immutable `*.analysis.json` when comparing several runs:

```sh
npm run build:glide-packages -- \
  --input=dist/glide-cache/frozen/latest.json \
  --reassemble --output=dist/glide-assembly-test
```

This explicit mode requires GDAL and runs/reuses final merge and assembly, then
packages its result. It does not acquire sources or screen terrain/cover/hazards.
Its cache key includes the selected snapshot, assembly implementation and GDAL
versions; it never substitutes the current screening rules for historical ones.
`--force-packaging` leaves completed assembly checkpoints reusable.

Assembly may change record boundaries, representative qualifications and IDs.
The report compares baseline/output record, ring, hole, vertex and tier counts,
plus order-independent fingerprints of exact records, boundary encodings, holes,
qualifications/flags and feature IDs. Encoding differences do not necessarily
mean different ground coverage; this is not a geometric-union equivalence test.
Lossless packaging starts from the newly assembled records in this mode.

An old `analysis-vN/` folder alone is insufficient to establish a complete
historical snapshot. Use the explicit recovery mode above for a completed older
analysis run, or its published manifest for exact repacking. Recovery provenance
is distinguished from the complete historical inventory used by `--reassemble`.

## Shared glide delivery v1

The discovery discriminator is `product: "glide-packages", schemaVersion: 1`.
It is independent of `source.schemaVersion` (8 or 9), the original engine label,
`overview.version` and `packagingSha256`. `source` retains original rules and
metadata; root `inputSha256` identifies the pinned publication, while
`source.inputSha256` remains its historical build identity. `generatedAt` retains
the source's calculation timestamp so identical fixed-input runs are deterministic.

```text
charts/glide/
  manifest.json
  snapshots/<sha256>.json
  indexes/<sha256>.json
  regions/<sha256>.json
  dependencies/<sha256>.json       # larger region inventories
  detail/<sha256>.gld
  overview/<sha256>.glo
  coverage/<sha256>.json
  provenance/<sha256>.json
```

Artifacts have `{file,bytes,sha256}` descriptors. Files are immutable and shared
across regions. A snapshot is byte-identical to discovery; compute the discovery
SHA to find its snapshot. All artifacts precede the atomic discovery switch.
Root indexes reference bounded spatial pages rather than every polygon block.
Index pages contain archives, their actual bounds and block directories; archive
and page bounds enclose every whole polygon, including cross-tile polygons.

Whole polygons receive one storage owner using their qualification midpoint's
z10 tile. Archives group nearby tiles using the chart grid's 8 × 8 roots and split
at size limits. Region selection uses actual archive bounds, not just owner tiles.
It can intentionally overfetch nearby blocks while retaining every intersecting
polygon without duplicating its storage.

| Unit | Version-1 bound |
| --- | --- |
| Complete active release | `< 5,000,000,000` bytes |
| Archive | 2 MiB including header/directory |
| Directory | 256 KiB; at most 512 blocks (publisher groups at most 128) |
| Ordinary detail block | 256 KiB gzip; 1 MiB raw; 65,536 vertices; 16,384 rings; 4,096 records |
| Explicit large singleton | 1,792 KiB gzip; 8 MiB raw; 524,288 vertices; 65,536 rings; exactly one record |
| Index/dependency page | 512 KiB; at most 512 archive/file entries |
| Region inventory | 512 KiB; larger file lists use dependency pages |
| Overview block | One 256 × 256 tile; 196,608 raw bytes |

An indivisible polygon exceeding ordinary raw/complexity limits can be marked
`oversized: true` and placed alone in its archive within the larger bound. The
national input contains such records; silently changing their boundaries would
violate exact repacking. Clients must schedule these exceptional reads explicitly.
Records above the hard bounds fail publication rather than being discarded.

### Archive and block decoding

Both `.gld` and `.glo` containers are **not outer-gzipped**. Bytes 0–7 are ASCII
`GLIDEP01`; bytes 8–11 are the unsigned little-endian JSON directory byte length;
bytes 12–15 are reserved zero. The UTF-8 JSON array immediately follows the
16-byte prefix. Its offsets start at zero relative to the payload after the
directory. Spatial index offsets and `readArchiveDirectory()` results are absolute
archive byte offsets. Payloads are contiguous independent gzip members.

Validate header/version, directory bounds, block counts/sizes and offsets before
reading or allocating. Read the selected member with `Blob.slice` or an equivalent
range operation, verify compressed length/SHA, inflate with the declared raw bound,
then check decoded counts/bounds. Neighboring members do not need decompression.
Do not apply HTTP `Content-Encoding: gzip` to the container.

Detail member JSON is `{source,indices,areas}`: one original shard SHA, original
record indices and unchanged tuples described below. Directory entries carry
schema, tile, actual bounds, compressed/raw sizes, SHA, records, vertices, rings,
tier counts and optional `oversized`. Index pages repeat the same entries with
absolute offsets. Geometry decoding remains independent of archive boundaries.

The [committed client fixture](../test/fixtures/glide-delivery-v1/README.md)
includes a complete manifest graph, shared regions, exact expected records,
holes and both tiers. The encoder/reader and independent verifier are in
`lib/glide-package-archive.ts` and `lib/glide-package-verify.ts`.

### Numeric overview

Every tile is row-major, north to south, with three interleaved unsigned bytes:
`[preferred, bestEffortOnly, prepared]`. Divide by 255 for sampled ground-area
fractions. Palette and opacity belong to the client. Preferred wins overlap,
including overlap across source shards; holes remain excluded. The invariant is
`preferred + bestEffortOnly <= prepared <= 255`.

Use fixed Web Mercator tiles, 256 pixels square, zooms 0–10 by default; z11 is
optional. At the finest level, scan conversion samples 4 × 4 subcell centers per
pixel, unions tier masks before counting, and weights subrows by their spherical
ground area. Parents use area-weighted Float64 values, not previously rounded
bytes. Each published level is independently quantized, avoiding cumulative
rounding. Very small densities can still round to zero.

Prepared pixels describe source-region rectangles plus represented polygon
samples, **not per-pixel source completeness**. Prepared empty tiles are included;
zero candidates does not certify unusable ground. Outside prepared coverage is
unavailable. Original missing-evidence flags and provenance remain authoritative.

Run `npm run measure:glide-overview` for the analytic sampling probe: 600 m long
rectangles at 25°, 40° and 49° latitude, with twelve grid alignments. For 300 m
width, maximum area error before byte quantization is about 9.6% at z10 and 3.9%
at z11. At 18.288 m width, some z10 alignments disappear entirely; the tested z11
maximum error is still about 84.9%. These are synthetic sampling measurements,
not national accuracy estimates. The z10 default is for broad density browsing;
detail supplies precise narrow openings. No mobile-device performance claim is
established by publisher tests.

### Region caching, retention and rollout

For a pinned region inventory, enumerate its inline `files`, or load all
`filePages` and enumerate their `files`. Save the inventory, dependency pages,
listed local index pages, shared archives, coverage and provenance. This closure
includes all advertised overview levels and detail, regardless of the viewport.
`downloadBytes` counts that closure once. The pinned root/snapshot is release-level
metadata, shared by region plans and accounted in the release total.

Coverage is `available`, `partial` or `unavailable` relative to declared source
rectangles. It is separate from dependency completeness. Alaska/Hawaii remain
unavailable for a CONUS source. Selection has no outward glide-range buffer beyond
the existing region envelopes; an origin at the border may require neighboring
regions for its full reachability area.

ZLayer still needs to add glide artifacts to region plans, verified file storage,
service-worker downloads, readiness and cleanup, and read these archives from
durable storage. Save the selected snapshot identity with the plan. Shared files
must survive removal of another region, and saved/staged/previous plans must keep
their dependencies protected. Offline reload, interrupted updates, overlapping
region removal and sustained moving-ownship detail require client/device testing.

New-format cleanup preserves **all committed snapshots** and their dependencies;
it removes only failed/unreferenced artifacts. Reusing an output can therefore
retain extra generations beyond the active release budget. To obtain a clean
active-only export, choose a destination with no existing `charts/glide/`:

```sh
npm run build:glide-packages -- \
  --output=dist/glide-packaging-test --export-active=dist/glide-active-export
```

This verifies and copies just the active graph, without build caches or historical
snapshots. Exported artifact directories use mode `0755` and files use `0644` so
the web server can read them. For manual uploads, use
`rsync -rpt --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r --delay-updates`, upload immutable
files before `manifest.json`, and omit `--delete`. The permissions option also
repairs an existing destination created from a private temporary directory.
Cleanup does not silently revoke clients' pinned releases. Keep the
new product staged until its ZLayer reader and offline-region integration land.

### National packaging measurement

The 2026-10-03 schema-8 publication, input SHA
`9e835a53f71b857a1ed10269cb84f51c300be6f78172eee868b398faa991381f`,
was repackaged with default regions and overview z0–10:

| Component | Active bytes |
| --- | ---: |
| Detail archives, including directories | 3,875,402,209 |
| Overview archives, including directories | 313,486,630 |
| Indexes, regions, coverage, provenance, discovery and snapshot | 110,466,333 |
| **Complete active release** | **4,299,355,172** |

All **5,857,373** input records are retained exactly, across **69,640** detail
blocks. There are **16,050** overview tiles and **2,832** shared archives in total.
Median detail raw size is **266,009 bytes**; p95 is **403,293 bytes**. The 294 large
singletons have an observed maximum of **390,254 vertices** and **2,488,054 raw
bytes**. No detail record exceeds the declared exception bounds.

Compressed detail members alone grew from 3,813,597,769 to 3,849,414,945 bytes
(about 0.94%); archive directories and the overview/index products account for
the remaining growth. The overview exceeds the initial 150 MB planning target,
but the complete release stays about 700 MB below the strict 5 GB ceiling. These
measurements apply to this frozen input; future datasets and z11 must pass their
own full-release size check. No phone rendering timings were measured here.

## Parallelism and GDAL

- `--concurrency=1..16` controls the **shared** chunk-worker pool. Default: the
  smallest of 16, half the available logical CPUs, and one worker per 4 GiB
  available RAM, with at least one worker.
- `--region-concurrency=1..16` controls regions analyzing, plus a bounded queue
  of preparing/ready regions. Default: the smallest of 8, the chunk-worker count,
  and one region per 8 GiB available RAM. An ample-RAM 32-thread machine defaults
  to **8 regions / 16 shared chunk workers**, not 16 workers per region.
- `--assembly-concurrency=1..16` independently controls final assembly groups and
  their GDAL pool. The default remains the smaller of 4 and the region concurrency.
  Use 8 on a machine with spare CPU and RAM; compare throughput and memory before
  increasing further. Screening workers are released before this pool starts.
  Changing this setting reuses the same analysis, merge and gzip checkpoints.
- Slow downloads do not block other ready regions. A surface waiting for hazards
  releases its CPU slot and later resumes without repeating terrain screening.
  Region limits bound these waiting arrays. No GPU processing is used.
- Charts and glide share [gdal.ts](../lib/gdal.ts): persistent Node processes
  call the installed GDAL C APIs via `koffi`; a version-checked CLI fallback is
  available. No Python runtime or second GDAL installation is bundled.
- Remote DEM reads and local work use separate bounded GDAL pools. DuckDB's
  extensions initialize before concurrent GDAL startup to avoid the observed
  native initialization deadlock. Repeated source/mask requests are shared.

The log identifies the GDAL backend. `GDAL_BACKEND=native` requires native mode;
`GDAL_BACKEND=cli` selects utilities; `GDAL_LIBRARY=/path/to/libgdal.so` selects
an explicit library. Used tools and the loaded library must have matching versions.
TLS verification stays enabled. Explicit `CURL_CA_BUNDLE` / `SSL_CERT_FILE`
settings take precedence, then `NIX_SSL_CERT_FILE` or an available host CA bundle.

## Build and cache behavior

- Source downloads and derived native masks have verified cache identities.
  Chunk checkpoints live in `glide-cache/analysis-v1/area-chunks/` and
  `ground-rejections/`. Receipts verify their input identity and output bytes.
- Analysis keys include source hashes/interpretation/coverage, rules, tool
  versions, chunk geometry and the explicit analysis revision from
  [glide-identity.ts](../lib/glide-identity.ts). Ground-only rejection keys omit
  hazard identities; full candidate keys include them. Only land-cover, fine-cover,
  canopy and mapped-ground dates affect these keys, because their relative recency
  affects cover reconciliation. Other source dates remain in provenance. An exact
  match against the former all-dates key can adopt a verified checkpoint without
  rerunning analysis. A pinned compatibility profile also adopts the known
  October 3 run's old code-hash receipts, retaining its outlines. No source code
  is hashed to decide whether analysis needs rebuilding. Changed screening inputs
  still require reanalysis; unknown historical implementations are not adopted.
- Bump `GLIDE_ANALYSIS_REVISION` in [glide-identity.ts](../lib/glide-identity.ts)
  deliberately when changed analysis semantics invalidate saved results. Compatible
  performance edits leave it unchanged. This revision is independent of public
  engine **v1**, record schema **9**, and delivery schema **1**.
  The historical v20→v1 label reset changed neither screening rules nor record
  encoding; repackaging older publications preserves their original engine label.
- Each chunk is saved as it completes, before regional/final assembly. A later
  download or packaging failure does **not** require starting analysis over.
  Use `--assembly-only` once analysis is complete; earlier failures can resume
  with the normal command, which reuses unchanged completed chunks. An already
  running process keeps its loaded code until restarted.
- Packaging has a separate identity. A shard-layout change rebuilds assembly
  without invalidating terrain/cover/hazard checkpoints. Merged batches are also
  checkpointed in `analysis-v1/area-shards/`.
- Finished gzip shards and their batch/group receipts persist in
  `analysis-v1/assembly/`, outside the temporary work directory. Each batch is
  committed before progress is reported. A restart verifies checksums and reuses
  completed groups without parsing, merging or compressing their polygons again;
  an interrupted group resumes from its saved gzip batches. Existing merge-only
  checkpoints need one encoding pass to populate this cache. Missing or corrupt
  gzip files are regenerated from verified merged polygons where available.
- Scheduling cannot change input order: regional spools are assembled in stable
  region/chunk order. Analysis temporary files are removed after use. A failed
  build drains active jobs and retains committed checkpoints and the previous
  published manifest.
- Content-addressed artifacts are published before the manifest swap. Old
  generations remain until `npm run clean:generated` verifies the active manifest
  and removes unreferenced managed files. Cached source originals remain.

Implementation entry points: [fit and connected-ground search](../lib/glide-analysis.ts),
[raster and hazard screening](../lib/glide-raster.ts),
[polygon generation](../lib/glide-areas.ts), and [display cleanup](../lib/glide-display.ts).

### Source identity on restart

Automatic discovery selects sources again on each run. The Overture/FAA
snapshot is held within that process, but a restart does **not** pin the preceding
run's source snapshot. FAA acquisition checks the provider even without
`--refresh-sources`. A changed source file checksum invalidates dependent chunks;
ground-only rejections remain reusable when their own inputs still match.

This also catches harmless byte changes: during the October 3 restart, one
regional FAA subset had the same 310 features in a different order. Its checksum
changed and eight candidate chunks were recomputed. Order-independent feature
identity and pinning automatic sources across restarts are **not implemented**.
The explicit analysis revision solves code-change invalidation, not this source
identity limitation. Do not bypass source verification to force reuse.

### Reading progress

Progress percentages count completed **regions**, not estimated elapsed time.
Assembly logs distinguish `reused completed group`, reused gzip batches, reused
merged polygons, and newly merged/encoded batches, with elapsed time. The group
counter starts at zero on each run while cached groups are verified; it does not
mean their work is being repeated. Source/chunk verification and spool creation
still precede assembly, and new unions still require GDAL processing.
Per-chunk percentages use the whole analysis grid including halo and water;
`qualified ground` is not the fraction of dry land covered. The longest inspected
run can lie in the halo and is not an exhaustive maximum. Largest hazard losses
are counted against terrain-passing cells, overlap, and are diagnostic only.
Zero candidates can mean missing required coverage or rejection at one of these
stages; it does not certify that no real emergency option exists.

## Interactive preview

Run `npm run preview:glide` and open **http://127.0.0.1:4177/**. Optional
`--output=PATH` and `--port=NUMBER` select another build directory or port.
The dashboard reads completed chunk checkpoints while the build runs; it does
not acquire sources or run terrain analysis. The default selector is current
**v1**; historical snapshots remain explicitly selectable and are not mixed.

Live results refresh every 30 seconds. Use the map presets or enter coordinates,
filter green/purple, adjust fill opacity and inspect a patch's dimensions,
elevation and flags. The analysis grid distinguishes completed checkpoints from
missing ones. Zoomed-out views check commit receipts and file timestamps without
loading the national geometry; detailed requests also verify checkpoint hashes and
read at most 256 nearby chunks. Unfinished writes are reported as pending.
Concurrent requests share checkpoint reads. Export the viewport as GeoJSON. This is a checkpoint preview
before final cross-chunk merging, so polygons can overlap.

New visits open the U.S. build overview so completed regions are visible before
a particular city finishes. A saved URL restores its location. If the server
still reports an older version after an update, restart **the preview process**
and reload the page; restarting the builder alone does not reload preview code.

Satellite/street backgrounds require internet and are for manual inspection only.
Saved `dist/glide-preview/samples/*.json` demonstrations appear separately from
live data. Selecting a historical sample also selects its analysis version for
subsequent live views and saved URLs. Sample metadata is cached separately; a
sample view reads only that sample's geometry. Restart an existing preview server after updating its code, then
reload the browser; later completed build chunks appear without another restart.

## Legacy polygon consumer contract

Schema **9**, `status: experimental-candidates`,
`geometryMeaning: generalized-candidate-area`. ZLayer also reads legacy schemas
4–8 under their original dimensional/flag restrictions.

Each gzip file contains a JSON array of records:

```text
[
  [lon1E6, lat1E6, lon2E6, lat2E6, widthFt, usableLengthFt, maximumElevationM, tier,
   alongGradePermille, crossGradePermille],
  [[lon0E6, lat0E6, deltaLon1E6, deltaLat1E6, ...], ...],
  flags
]
```

The first tuple is a contained qualification witness, not display geometry.
Coordinates are integer millionths of a degree. Elevation is the ceiling of the
maximum over the witness and numerical end allowance, in source MSL metres;
it is not the height of every point in the polygon. Wire tier **1 = purple**,
**2 = green**. These identifiers are not quality-priority ranks. The last two
integers are signed overall grades in per-mille (divide by 10 for percent),
along endpoint 1→2 and perpendicular to it. Legacy tuples contain eight values;
schema 9 requires ten. Builder v1 remains the stable pre-release label.

The second item is a Polygon, exterior ring first then holes. Start each ring at
`(0,0)`, cumulatively add each integer pair and divide by 1e6. The closing vertex
is implicit. Render the supplied connected area, not a rectangle from the witness.

`flags` uses these bit values, also described by the manifest's `flagBits`:

- **1:** cultivated surface, crop condition unverified.
- **2:** shrub surface unverified; **4:** broader shrub band (requires 2).
- **8:** canopy-model disagreement supported by independent open-ground evidence.
- **16:** sloped/uneven ground; **32:** developed open space.
- **64:** reduced building/barrier setback; **128:** bare/mixed surface unverified.
- **256:** constrained fit or reduced ground clearance.
- **512:** reduced obstacle exclusion.
- **1024:** corroborated land-cover disagreement; purple only.

Only crop bit 1 may appear on green. A purple fit shorter than 1,500 ft or narrower
than 100 ft must carry bit 256. Merging preserves compatible quality flags and
propagates crop uncertainty. Unsupported bits are rejected; no flag means only
that the listed compromise was not used, not that a surface was verified safe.

### Bounded spatial shards

One degree is an **assembly grouping**, not a guaranteed one-file delivery unit.
[glide-shards.ts](../lib/glide-shards.ts) streams ordered regional spools into
merge batches targeting at most **8 MiB raw / 100,000 records**. A single original
polygon is indivisible and may exceed that merge target; final file limits still
apply. Compatible patches are dissolved within each batch.

Assembly checks originals before union and checks the exact delivered polygons.
New analysis also checks validity and full-width fit containment **after** E6
rounding at both simplification stages. If a simplification fails those checks,
it retains the preceding screened outline and validates that fallback too. This
avoids creating precision defects that would later need lossy assembly cleanup.
Valid originals stay unchanged. For an invalid original, interpret its shell and
exclusion rings separately, make their topology valid, and subtract all exclusions.
Try that geometry at delivery precision, then an inward adjustment of one or two
coordinate-grid units if necessary. Accept exactly one connected polygon only when the final
encoded geometry is valid, remains inside that reference, intersects no exclusion,
contains the **full original fit**. Disconnected pieces without that fit are
removed; the display simplifier's 2% budget does not prevent cleanup of invalid
topology. If no valid piece contains the full fit, omit that invalid patch.
Every cleaned or omitted patch is logged with its fit and, for retained patches,
measured area loss. Stored analysis, fit metadata and flags remain unchanged.
Union operates on the cleaned copies, so it cannot restore discarded ground.
Unsupported defects and unrelated tool/I/O errors still stop delivery.

Assembly uses the merged polygons' GeoPackage R-tree to shortlist qualifications,
then applies the exact midpoint containment and quality ordering. An unmatched
union component is explicitly rejected or recovered from originals; a join must
never silently omit it. Valid-input cases in [glide-merge.ts](../lib/glide-merge.ts)
are checked against the reference merger for identical polygons and delivery bytes.

A collection that exceeds **16 MiB raw**, **2 MiB gzip**, or **100,000 records** is
recursively split by the median qualification midpoint along its widest spatial
axis. Whole polygons retain their fits. If union creates an oversized or invalid
polygon, replace only that polygon with validated original patches of the same
quality whose bounds overlap it. Bounds include every possible contributor,
even when its fit midpoint lies elsewhere. Apply the same precision checks to
any invalid original needed by this fallback. A collapsed ring or unmatched
component uses the same polygon-local fallback. A null union uses validated
originals from the affected quality group. Missing replacements, an original
that exceeds a shard limit, and unrelated tool/I/O errors still fail explicitly.

All delivered polygons pass GEOS validation after encoding, including recovered
originals and cached merges. Delivery version 3 leaves analysis identities intact.
Version-2 gzip batches and legacy merges are reusable after their original patches
validate. Batches containing invalid originals must be recomputed: an old union
could appear valid after silently omitting a disconnected component. Successful
new batches and completed groups remain resumable. The previous publication
remains intact until every group succeeds. Shard IDs are opaque; clients must use
the manifest's actual polygon bounds, which can overlap and include halos.

Consumers union loaded areas across file boundaries, retaining quality flags,
so bounded server-side merge batches do not introduce visible internal outlines.
The manifest records hashes, raw/compressed bytes, counts, tier counts, provenance,
rules and assessed center coverage. ZLayer selects intersecting shards along the
route ±20 NM and retains decoded results across pan/zoom. It loads bounded local
subsets; the publication is not one nationwide geometry response. The manifest
currently supports at most **10,000 shards**; an aggregate delivery budget is optional.

An absent shard inside coverage means no selected candidates, not certified
unusable land. Outside coverage means unassessed; even an assessed rectangle can
contain unknown source pixels. No rasters, imagery, per-cell suitability grid or
hazard dataset is shipped with the polygons.

## Optional custom source inventory

`--sources=FILE` replaces automatic acquisition for local data or reproducible
fixtures; it cannot accompany `--bbox`. See
[glide-sources.example.json](../data/glide-sources.example.json). Its placeholder
paths are not needed for a normal build.

Each region has nonoverlapping candidate-center `bounds` and `coverageBounds`
extending at least 12 km farther, in `[west,south,east,north]` WGS84 coordinates.
Every asset records name, date and attribution. Local paths are relative to the
inventory; remote HTTPS inputs require pinned `sha256` and `bytes`. Sources must
retain their attribution/license obligations, including those of upstream maps.

Required raster families are `elevation`, `landcover`, `canopy`, `impervious`;
required vectors are `buildings`, `powerlines`, `obstacles`, `water`, `roads`.
All vector families must have been acquired across the claimed coverage. Empty
means a successful empty query, not an omitted acquisition.

Raster assets must be self-contained, north-up, single-band GeoTIFFs without
scale/offset, with embedded validity masks/NoData and georeferencing. No external
sidecars or externally referenced VRTs. DEM values are metres MSL in a consistent
non-ellipsoidal datum; datum conversion is the inventory producer's responsibility.
Numerical cover encodings and source-resolution limits match the criteria above.

Optional `shrubCover` and `shrubHeight` must be supplied together, aligned in
meaning/date; without them shrubland cannot pass. `shrubTreeCover` remains readable
in legacy inventories but cannot override Science TCC. Optional `fineLandcover`
uses native WorldCover classes at ≤12 m. Optional `ground` assets declare
`groundSource: mapped` and `groundClass` **1 open / 2 bare-beach / 3 excluded**.
Positive mapped ground is inset by half the cell diagonal plus 0.1 m; exclusions
expand 5 m and win overlaps. Bare corroboration still needs NLCD bare evidence.

Vectors use one valid georeferenced GeoJSON or GeoPackage layer per asset.
Retain obstacle `structureType`, AGL `heightAglFt`/`heightM`, and
`horizontalAccuracyCode`/`horizontalAccuracyM`. Declare
`obstacleSource: mapped | faa-dof`, `buildingSource: footprint | ground-barrier`,
and `roadSource: typed` when applicable. Untyped inventories keep conservative
interpretations. Null geometry or invalid/missing required products fail the build.

## Reference coverage and remaining limitations

A predecessor of the current strategy was reviewed on **31 chunks across six scenes** on
2026-10-02, before the v1 label reset. Exact bounds, source identities, code hashes,
reports, replay evidence and screenshots are in
`dist/glide-preview/v20-review/`; matching v1 samples are in the dashboard.

| Scene | Purple areas | Marked known-land area | Sampled land within 3 NM of a witness |
| --- | ---: | ---: | ---: |
| Oakland–Concord / East Bay | 160 | 0.77% | 99.6% |
| SF coast | 28 | 0.72% | 93.0% |
| LA basins/coast | 93 | 0.54% | 84.7% |
| Key West / surroundings | 6 | 0.49% | 91.2% |
| Salida / Arkansas Valley | 370 | 7.35% | 98.1% |
| Leadville valley | 179 | 2.72% | 92.2% |

Proximity uses a 500 m known-land sample and distance to a qualification midpoint;
it is **not glide reachability** and ignores terrain barriers/approaches. These
selected scenes do not estimate national coverage or validate actual landability.
Green witnesses, flags and polygon coordinates were unchanged in that strategy
comparison. The six samples together compressed to about 276 KiB; national size
has not been established by those samples.

Key West has one short off-airport candidate (636 × 100 ft) on the north side;
the other five are Boca Chica infields. Smathers Beach still has none. A narrow
Bay pond-edge candidate remains suspect against the aerial background: source
bare classification lies outside mapped wetland/water exclusions. Adding mapped
wetlands removed other candidates but did not resolve that boundary disagreement.
These counterexamples remain in the gallery. More candidates alone do not prove
better recommendations, and purple must continue to communicate uncertainty.

### Geometry performance check

On 2026-10-03, replaying display reduction on three already processed local
chunks (269 polygons, 85,649 input vertices) gave the following results. Each
timing is the median of three runs with persistent native GDAL; source acquisition,
raster screening, fit search and final assembly are excluded. All holes were
protected because a cached polygon alone cannot establish why a hole exists.

| Chunk | Previous display time | Updated display time | Previous / updated vertices |
| --- | ---: | ---: | ---: |
| `conus-w100-n26--793-211` | 380 ms | 97 ms | 12,153 / 9,802 |
| `conus-w86-n30--688-242` | 193 ms | 55 ms | 6,543 / 5,534 |
| `conus-w99-n30--792-247` | 2,141 ms | 281 ms | 66,806 / 61,245 |

With the shape protections above, this sample's display pass was about **6.3×
faster**, with **10.4% fewer vertices** and **7.3% less gzip JSON** than the original
clipped topology simplifier. All 269 records, 1,161 holes,
qualification tuples and flags remained. These are incremental reductions on
already generalized inputs, not estimates of national build time or final package
size. Replaying already generalized inputs cannot restore previously removed
shape vertices or measure the cost of early polygon simplification. The repeated
display simplify/intersection evaluations were avoidable work; the early 10 m
polygon reduction now runs once per candidate. The 10 m raster preparation and
full-footprint searches still run independently.

### Completed publication and screening refinement

The earlier national schema-8 publication completed. Its original and interrupted
stricter-run checkpoints may be mixed, as authorized for that first upload.
Those historical samples are not evidence of current-policy coverage.

The changes from **`glide/obstacle-screening`** are now incorporated into the main
working tree, with corrected ordinary-obstacle classification, connected-opening
recovery and corroborated cover disagreement handling. Green criteria and purple
minimum dimensions, terrain bands and shrub bands have not changed.

Those screening refinements required new analysis; the crane query change also
invalidated its affected mapped subsets. That historical mixed-policy exception
does not authorize arbitrary old checkpoints today. Current reuse follows the
[explicit revision and pinned compatibility profile](#build-and-cache-behavior),
plus matching source identities. Code edits alone no longer trigger reanalysis.
Existing published data stays readable until replacement analysis, assembly and
atomic publication succeed.

### Refinement spot checks

One existing 1/8-degree chunk per scene was reprocessed from cached published
sources without changing production checkpoints. Counts below are qualified
polygon records before assembly, not land coverage or independent landing options.
The baseline is the completed build's possibly mixed-policy checkpoint.

- East Bay hills (`conus-w123-n37--977-303`): **20 → 12**.
- SF coast (`conus-w123-n37--980-302`): **7 → 5**.
- LA basin (`conus-w119-n34--948-273`): **27 → 20**.
- Key West (`conus-w82-n24--655-196`): **0 → 0**. FAA obstacle buffers exclude
  9,105 of the 9,743 cover-eligible grid cells; exclusion counts include the halo
  and overlap other hazard sources. No candidate was manufactured to fill this gap.
- Colorado/Salida (`conus-w107-n38--849-308`): **212 → 199**, including one
  corroborated cover-disagreement patch.
- Colorado/Leadville (`conus-w107-n39--851-314`): **26 → 26**.

These results include the restored obstacle policy and other refinements together;
they do not isolate the connected-opening fix or predict national coverage.
A separate regression checks two fields connected through broader terrain: both
surviving gentle openings retain independent fits, while an undersized detached
remnant remains unmarked. Green thresholds and purple floors stay unchanged.

Saved `refinement-*` samples are in `dist/glide-preview/samples/` and appear in
the existing dashboard after reload. Raw before/after counts and overlapping
polygon-area sums are in `dist/glide-preview/refinement-report.json`; those sums
are not union area or a coverage percentage. No national rebuild was run for this
review, and the completed publication's manifest checksum is unchanged.

### Repeatable geographic review

Run `npm run review:glide` to read committed checkpoints without acquiring sources
or running terrain analysis. The six windows in
[data/glide-review-scenes.json](../data/glide-review-scenes.json) cover East Bay,
SF coast, LA, Key West, Salida and Leadville. Outputs are
`dist/glide-preview/review/report.json`, one GeoJSON per scene, and saved samples
in the existing preview dashboard's sample selector.

The report measures the clipped polygon **union** in an equal-area projection,
so overlapping chunks do not inflate square kilometres. It reports raw patches,
flags, and single-link groups whose measured fit centers are within 1 NM.
Groups are a geographic diagnostic, **not independently usable alternatives**.
The 1 km gap sample covers the entire review rectangle, including water and
unassessed pixels; it must not be called a land-coverage percentage or a glide
calculation. Actual terrain-aware arrival planning belongs in ZLayer.

The Key West review separately counts fit centers in an approximate Boca Chica
vicinity window. This is review context, not an airport boundary or a claim that
all those areas are off-airport alternatives. The Bay pond-edge probe remains a
manual source-quality check: bare-looking pixels outside mapped water/wetland
can still be unsuitable. A positive patch count cannot close this finding.
Neither a higher coverage percentage nor relaxing terrain criteria resolves
missing or inaccurate wetland, tree or obstacle data. No location-specific
acceptance overrides are used to make the reference scenes look better.

During a rebuild these reports can contain checkpoints from the previous
screening implementation. Their timestamp records the review time, not proof
that every input was re-screened. Re-run the review after the build completes.

ZLayer retains each qualification and its flags for **Inspect landing area** in
the map menu. The selected fit's midpoint and maximum fit elevation drive one
on-demand reverse glide calculation, sharing the airport terrain engine and its
500 ft arrival reserve. The panel measures route distance inside that footprint.
This is straight-line, still-air arrival coverage; approach alignment, surface
condition and stopping performance remain separate. The static green/purple
patch fill continues to mean prepared surface candidates, not reachable ground.

## Remarks

The purpose is to help pilots unfamiliar with an area notice plausible local
options for a **crash landing**. Local knowledge and visual assessment add
information these datasets cannot supply. Short, sloped or uncertain openings
belong in that search when their compromises remain visible.

The current strategy has a sound foundation: qualify a whole straight fit,
preserve local alternatives, screen terrain and mapped hazards, retain uncertainty
flags, and calculate reachability separately. Refinement should preserve that
architecture. Neither candidate counts nor shaded area alone establish usefulness.

**Proposed coverage work:** investigate specific missing openings before changing
thresholds. The existing 10 m corroboration can still lose openings to coarse
forest/canopy evidence or a missing mapped-open annotation. Test recovery rules
separately: low-canopy openings without a positive mapped-grass annotation, then
corroborated forest disagreements within the existing purple canopy allowance.
These are experiments, not current policy. Recovered ground should remain purple;
required evidence, explicit exclusions, terrain, hazards and full-fit checks still
apply. Cases beyond those canopy limits need evidence locating the trees within
the coarse pixel, rather than a blanket threshold increase.

Review a small, repeatable set of missing openings and inspect both recovered fits
and unwanted additions. Success means more useful places for an unfamiliar pilot
to consider, with understandable compromises; measured improvement should guide
further changes.
