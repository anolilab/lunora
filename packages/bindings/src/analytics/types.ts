import type { AnalyticsEngineDataPoint } from "@lunora/platform";

/**
 * Structural types for the Analytics Engine write path.
 *
 * The real binding is workers-types' `AnalyticsEngineDataset`. We mirror it
 * **structurally** (`AnalyticsEngineDatasetLike`) so plain-object test doubles
 * satisfy the contract without pulling workerd into a unit test — the same
 * approach `@lunora/d1` takes with `D1DatabaseLike`
 * (`packages/d1/src/d1-client.ts`).
 */

/**
 * Named-field event handed to {@link AnalyticsClient.track}. Each field is
 * mapped to a positional AE column and the mapping recorded in a returned
 * {@link TrackSchema}, so the read side can reconstruct named columns from the
 * SQL API's positional `blobN`/`doubleN`/`index1` output.
 */
export interface TrackEvent {
    /** String dimensions → `blobs` (`blob1..blob20`), in object key order. */
    dimensions?: Record<string, string>;
    /** Single high-cardinality sampling key → `index1`. */
    index?: string;
    /** Numeric metrics → `doubles` (`double1..double20`), in object key order. */
    metrics?: Record<string, number>;
}

/** One named field's position in the AE positional layout. */
export interface TrackColumn {
    /** Positional AE column it maps to (`blob3`, `double1`, `index1`). */
    column: string;
    /** Field name from the {@link TrackEvent}. */
    field: string;
}

/**
 * The field→column mapping {@link AnalyticsClient.track} records for one event
 * shape, so the read side can project the SQL API's positional columns back to
 * named fields. `name` is the logical event name; the column arrays are in the
 * same order the dimensions/metrics were written.
 */
export interface TrackSchema {
    dimensions: TrackColumn[];
    index: TrackColumn | null;
    metrics: TrackColumn[];
    name: string;
}

/**
 * The write-side client bound to `ctx.analytics` (the generated context imports
 * this exact type as `import("@lunora/bindings/analytics").AnalyticsClient`). Telemetry
 * is fire-and-forget and sampled — never read a data point back in-handler.
 */
export interface AnalyticsClient {
    /**
     * Ergonomic named-field write: maps `{ dimensions, metrics, index }` to the
     * positional layout, writes it, and returns the {@link TrackSchema} mapping
     * (the logical `name` is recorded as the first blob, `blob1`).
     */
    track: (name: string, event?: TrackEvent) => TrackSchema;

    /**
     * Write a raw positional data point. Enforces AE's per-data-point count
     * caps (≤20 blobs, ≤20 doubles, ≤1 index) and byte budget (combined blobs
     * ≤16 KiB, index ≤96 bytes, measured as UTF-8); overflow throws so a misuse
     * surfaces in dev rather than being silently rejected by the platform.
     */
    writeDataPoint: (event: AnalyticsEngineDataPoint) => void;
}

export { type AnalyticsEngineDataPoint, type AnalyticsEngineDatasetLike } from "@lunora/platform";
