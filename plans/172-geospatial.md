# Plan 172 — Geospatial indexing & queries

- **Category**: feat (competitive parity — Wave 14 deep-pass, in `plans/README.md`)
- **Priority**: P2
- **Effort**: L · **Risk**: MED
- **Status**: TODO
- **Baseline**: `70331e9b` (2026-07-21)
- **Goal**: add first-class geospatial storage + queries (`near` / within-radius /
  bounding-box) to Lunora — the only wholly-missing data-layer capability that
  Convex, Supabase, and Firebase all answer.

## Context (verified)

Grep for `geo|geospatial|geohash|haversine|withinRadius|boundingBox|latLng|s2`
over `packages/*/src` and package docs returns **zero** hits. `packages/server/src/schema.ts`
has `index` / `searchIndex` / `softDelete` / relations — no geo counterpart.
Competitors: Convex (official geospatial component — point index, nearest /
within-radius / rectangle), Supabase (full PostGIS), Firebase (documented
geohash/GeoFire pattern). "Things near me" is a top-tier app query all three serve.

The existing index machinery is the seam: a geohash-prefix range query slots into
`ShardDO` SQLite exactly like `.searchIndex()` does.

## Phase 1 — Type + index

- [ ] `v.geoPoint()` validator in `@lunora/values` (lat/lng, validated ranges).
- [ ] `.geoIndex(name, { field })` on the `TableBuilder`
      (`packages/server/src/schema.ts`), mirroring the `.searchIndex()` shape;
      store a geohash column alongside the row.

## Phase 2 — Query

- [ ] `withGeoIndex(name, q => q.near(point, radius))` (and `.within(bbox)`) on the
      table reader, resolved as a geohash-prefix range scan in `ShardDO` +
      Haversine refine/sort on candidates.
- [ ] Codegen + typed inference for the geo query surface.

## Exit criteria

- [ ] Insert points, query `near`/`within` with correct ordering, verified on workerd.
- [ ] Advisor lint: `geoIndex` declared but unused / query without a geo index.
- [ ] Docs + example (a "places near me" query).

## Non-goals

- Full PostGIS geometry (polygons, projections) — points + radius/bbox is the target.
- Cross-shard geo ranking in v1 (single-shard first; revisit with the coordinator).
