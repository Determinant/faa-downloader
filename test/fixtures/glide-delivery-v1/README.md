# Glide delivery v1 fixture

`charts/glide/` is a complete immutable sample release, including discovery,
pinned snapshot, index pages, two overlapping offline regions and independent
detail/overview archives. All coordinates are synthetic. The schema-8 source
has two records: preferred ground with a hole, and overlapping best-effort ground.
`expected-detail.json` pins their exact records and original identities.

Run `npm run build:glide-packages -- --verify --output=test/fixtures/glide-delivery-v1`.
The fixture is also decoded by `test/glide-packages.test.ts`. Client integrations
can copy the complete `charts/glide/` directory without the publisher/cache.

See [the supported format](../../../docs/glide.md#shared-glide-delivery-v1)
for the header, offset convention, limits and dependency enumeration. A packaging
implementation hash identifies the code used to generate this fixture; clients
must dispatch on the delivery/record schemas, not that implementation hash.
