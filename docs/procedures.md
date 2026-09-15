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

The catalog contains every FAA airport and procedure record for the cycle. It keeps
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
