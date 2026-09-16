# d-TPP procedure catalog

Status: implemented

`faa-regs` builds the cycle-versioned procedure feed used by ZLayers. Downstream
clients do not need to parse FAA HTML/XML or split the combined TPP PDFs.

## Build

```bash
npm run build:procedures
npm run build:procedures -- --source-xml=/path/to/d-TPP_Metafile.xml
```

`build:charts` runs this stage automatically. A local source XML makes the standalone
build network-free.

## Output

```text
dist/charts/<effective-date>/tpp/
├── catalog.json
└── manifest.json
```

The catalog contains every FAA airport and active procedure record for the cycle.
It excludes records marked deleted and the FAA's `DELETED_JOB.PDF` and
`DEL_APT_SERVED.PDF` placeholders, including those with a blank action flag. It keeps
all procedure-record fields, including unknown fields, and adds:

- a stable record ID and normalized product kind;
- a canonical FAA individual-PDF URL;
- the exact named destination used by shared PDFs; and
- a combined-volume ID and verified zero-based PDF page index when available.

The manifest records cycle dates, source and volume SHA-256 hashes, counts, and schema
and builder versions. Its indexed and unindexed counts make partial regional builds
explicit. Outputs are staged and replaced atomically.

## Page targets

The FAA `bvpage` value is a printed page label, not a PDF page index. The builder reads
the combined TPP page geometry, matches the printed label at the physical page edge,
and publishes the zero-based index. It also locates each airport's first page in shared
sections for takeoff minima, textual ODPs, DVAs, alternate/radar minima, hot spots, and
LAHSO material.

FAA metadata volume `AK-1` maps to `tpp-ak.pdf`, and `PC-1` maps to `cs-pac.pdf`.
Pacific procedures use the supplement's terminal-procedure section headers for page
labels, so they cannot collide with the supplement's other numbered sections.

IAPs, airport diagrams, SIDs, charted ODPs, and STARs normally carry direct printed
page targets. Some military-only products have no combined-volume fields; those retain
their individual FAA PDF URL and have a null volume target. Any advertised target that
cannot be resolved makes the build fail.

The combined PDFs are immutable inputs. The builder only reads and checksums them; it
does not split, rewrite, or duplicate them. ZLayers can therefore open one original PDF
at the indexed page and cache that source file on demand.

Only combined volumes already present under `dist/charts/` are indexed. This keeps a
partial regional chart build valid while the nationwide individual-PDF catalog remains
complete.

## Chart Supplement airport pages

`npm run build:supplements -- --effective-date=YYYY-MM-DD` builds
`dist/charts/YYYY-MM-DD/cs/catalog.json` from the existing `cs-*.pdf` books and FAA's
small `afd_<edition>.xml` airport index. `build:charts` runs it automatically after
the TPP catalog. `--source-xml=PATH` supports offline builds; downloaded XML is cached
under `dist/supplements/`, outside the published chart tree.

Reruns hash the selected books and XML and verify the catalog against a local build
receipt before reusing it. Unchanged inputs skip directory-page scanning and leave
the catalog untouched. Changes to the available books, their contents or paths, the
XML, or the builder version require indexing again. Missing or modified catalogs
are rebuilt. `--force` explicitly rescans the books. Receipts also live under
`dist/supplements/` and do not need to be published.

The exporter verifies the PDF cover and XML effective dates, resolves printed page
numbers only inside the airport/facility-directory section, and fails on missing or
ambiguous targets. This avoids confusing Pacific's restarted terminal-procedure
numbering with its airport directory. NAVAID-only records and separate notice PDFs
are not airport entry points. Border airports may have an entry in two books.

The catalog carries the CS edition's own 56-day interval, exact zero-based page
indexes, and whole-book sizes and SHA-256 hashes. It includes airports without TPP
procedures. Publish this one JSON file alongside the existing PDFs; no MBTiles or
PDF rebuild is needed. ZLayer loads the small catalog when Plates opens, and only
downloads a regional book when its Chart Supplement row is selected.
