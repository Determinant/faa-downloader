# Terminal data build and review

The navigation build publishes one complete terminal edition. `download-charts.ts`
and `download-nasr.ts` both use this path. An approach chart in `tpp/catalog.json`
does not establish that its coded procedure exists in the navigation bundle.

## Ownership

| Module | Responsibility |
| --- | --- |
| `lib/cifp-source.ts` | Acquire required, dated CIFP input from the network, an extracted local file, or the matching ZIP; record archive and decoded-file hashes. |
| `lib/cifp.ts` | Validate the edition and fixed-width records; index scoped facilities; decode approach, departure and arrival branches with one leg decoder. |
| `lib/approach-routes.ts` | Project coded approaches into the existing client format; retain ambiguous/missing main branches in the unavailable ledger. |
| `lib/terminal-procedures.ts` | Validate NASR DP/STAR tables and joins; preserve filing identities, runway associations and waypoint topology. |
| `lib/terminal-bundle.ts` | Require all three coded families, assemble the output and reconcile source/exported records. |
| `download-nasr.ts` | Serialize builds, stage all navigation products, write their manifest, and replace `nav/` only after success. |
| `lib/procedures.ts`, `build-procedures.ts` | Build the independent d-TPP chart catalog and PDF targets, including IAP, DP/ODP and STR/STAR records. |

The chart parser already retains deleted-record handling, chart identity,
amendments, FAA computer codes and edition-specific PDF targets. It is deliberately
not used to invent coded legs or to equate similarly named NASR/CIFP procedures.

## Problems addressed

1. **Silent loss of every approach.** A local build without `FAACIFP18` previously
   succeeded and replaced `nav/` with a SID/STAR-only file. CIFP is now mandatory;
   missing input, a wrong edition, malformed coding or a missing coded family
   fails before replacing the previous bundle. There is no implicit partial mode.
2. **Different handling of terminal families.** CIFP PD/PE records were not
   exported. Departures and arrivals now use the same scoped facility index and
   leg decoder as PF/HF approaches. NASR filing topology remains unchanged and
   separate from coded, airport-specific branches.
3. **Unexplained source losses.** `NOT ASSIGNED` NASR rows now remain in an
   `excluded` ledger with their original fields. Empty routes, unassociated
   bodies, disagreements with the served-airport list and unresolved CIFP
   references have explicit diagnostics. They are not repaired by guessing.
4. **Insufficient validation.** All six NASR terminal tables require their
   schemas, including header-only tables. Orphan airport/body joins, duplicate
   associations, ambiguous bodies and duplicate point/leg sequences fail.
   CIFP orphan continuations and malformed numeric/altitude fields also fail.
   Conflicting facility definitions remain unresolved, independent of record
   order; identical definitions are harmless.
5. **Incomplete provenance and publication checks.** The manifest now records
   CIFP provenance, terminal bytes/hash and coverage. Source/exported leg counts
   must reconcile for every coded family; NASR rows must reach the output or the
   exclusion ledger. A navigation build lock covers source acquisition through
   publication and pruning.

## Output and compatibility

`terminal-procedures.json` retains `type: ZLayerTerminalProcedures`, its existing
`procedures` filing-route array, and `approaches: ZLayerApproachRoutes` schema 2.
The manifest's `count` still counts NASR filing records, as existing clients expect.
Additions are:

- `codedProcedures`: airport-scoped SID/STAR branches with source route types,
  transition identifiers and coded legs. No NASR-to-CIFP association is guessed.
- `sources` and `coverage`: CIFP identity and separate family/record counts.
- `excluded`, `sourceRows` and `diagnostics`: source accounting and unresolved data.
- `sourceFix` on an unresolved leg: its original scoped identity survives even
  when no trustworthy coordinates can be supplied.
- Surveyed runway thresholds for coded departures, and PA/HA airport-reference
  coordinates in the scoped facility index.
- Speed, RNP, vertical angle, transition altitude, RF arc radius, turn validity,
  GNSS/FMS and route qualifiers. Source altitude descriptions remain explicit.
- `continuations` on their primary legs, preserving all 132 characters and
  decoding W authorization/service names. Orphan, duplicate, mismatched and
  declared-but-missing continuations fail validation.
- `cifp-source.txt.gz`, a separate manifest product containing the entire original
  CIFP text with compressed and decoded hashes. Supporting records and fields
  beyond the current projection remain available for audit.

The updated ZLayer client validates and uses coded SID/STAR branches in its
runway/transition picker, map, saved routes and navlog. Existing filing topology
remains available for older clients and pasted filing strings. The reviewed
terminal JSON is about 55.4 MiB; the separate source archive is about 7.2 MiB.
The terminal file remains one shared national resource, and the client does not
automatically download the raw audit source.

This is a planning-data export, not a full avionics database. W continuations
describe service availability, not numerical minima. Other supporting ARINC
records and every constraint are not decoded into the client. The FAA readme
excludes CAT II/III, PRM, GLS, visual approaches, alternate missed approaches,
some military source data and generally converging approaches; the matching ZIP
also contains a procedure omission workbook. Publication accounting does not
establish chart-to-code completeness or valid geometry for every path.

## Verification against FAA cycle 2609

The review used the complete local FAA sources effective 2026-09-03, not only a
KVGT fixture. All existing fields in the current parser's 10,234 approaches and
1,849 NASR filing records were preserved. New fields are additive.

| Family | Procedures | Primary legs exported / in source |
| --- | ---: | ---: |
| Coded departures | 2,193 | 34,309 / 34,309 |
| Coded arrivals | 1,916 | 44,563 / 44,563 |
| Coded approaches | 10,234 | 122,204 / 122,204 |
| NASR departures | 1,159 | Filing topology, not coded legs |
| NASR arrivals | 690 | Filing topology, not coded legs |

All 201,076 primary legs and 6,744 continuation records are exported. Indexing
airport-reference records resolved 646 of the former 648 unresolved reference
occurrences: these were parser omissions, not missing FAA coordinates. The two
remaining references are PGSN Q07-Z's blank-section SN reference and KDAF R36's
absent CMY NDB. Neither is guessed from a similar identifier.

NASR diagnostics include 30 uncoded departure BASE rows (36 excluded
rows across all tables), 117 filing records without route sequences, 11 bodies
without airport associations and 10 airport/base-list discrepancies. The
unavailable-approach ledger is empty for
this edition but is exercised by regression tests.

The client's national audit offers 19,927 SID paths, 10,429 STAR paths and 37,836
approach entries. Every exported SID/STAR branch reaches a selectable path and
all 10,234 approaches have an entry. Geometry/source review diagnostics remain
on 93 SID choices and 201 approach choices, separately from 11,878 SID/STAR
choices with intentional manual endings. Source accounting is not a geometry
certification. Reproduce the report from the ZLayer repository with:

```sh
node --import=tsx tools/audit-terminal-coverage.mjs /path/to/cycle/nav /tmp/terminal-audit.json
```

Regression tests cover KVGT, real SID/STAR runway/transition branches, heliport
scoping, separate ILS DME antennas, missing and conflicting references, duplicate
legs, orphan continuations, incomplete families, local ZIP acquisition and
preservation of the entire previous navigation directory after build failure.

## Rebuild

Online:

```sh
npm run build:nav
```

Offline, with all eight NASR ZIP groups and either `FAACIFP18` or the matching
`CIFP_260903.zip` in the source directory:

```sh
npm run build:nav -- --source-dir=/path/to/2026-09-03/nasr --cycle=2026-09-03
```

An extracted CIFP file takes precedence over the ZIP and must match the requested
edition. Offline builds never silently fetch missing CIFP. Supply
`--route-history-source` as well when rebuilding a bundle that includes historical
filed routes; that independent product retains its documented offline behavior.

Upload the complete generated cycle's `nav/` directory and its matching manifest.
Do not upload only the terminal JSON. Existing pinned offline snapshots retain
their edition and must be refreshed through the client's normal download flow.
Neither code changes nor a successful local rebuild updates a hosted feed.
