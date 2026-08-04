/**
 * One `withGeoIndex("name", …)` read discovered in a function body — the use-side
 * input the `geo_index_unused` lint cross-references against the declared geo
 * indexes in the lint context's schema. Produced by the codegen feeder, which
 * walks the lunora source for `ctx.db.query("t").withGeoIndex(name, …)` /
 * `ctx.db.<table>.withGeoIndex(name, …)` reads and records each referenced index
 * name. Runtime callers don't supply it, so the lint finds nothing there.
 *
 * A `.geoIndex(name, { field })` maintains a geohash companion column on every
 * write; if no handler ever reads it via `withGeoIndex(name, …)` the companion is
 * dead overhead (maintained on every write, read by nothing) — the geo analogue
 * of a dead regular index.
 */
export interface AdvisorGeoIndexUsage {
    /** Source file the read appears in (relative to the lunora dir, no extension). */
    file: string;
    /** The referenced geo-index name; empty when the `withGeoIndex(...)` argument is not a string literal. */
    indexName: string;
    /** 1-based line of the `withGeoIndex(...)` call, or `0` when unknown. */
    line: number;
}
