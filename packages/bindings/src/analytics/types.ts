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
 * One Analytics Engine data point, mirroring the positional shape
 * `writeDataPoint` accepts. AE stores up to 20 string `blobs`, up to 20 numeric
 * `doubles`, and exactly **one** `index` (the high-cardinality sampling key) per
 * data point — the SQL API later exposes them as `blob1..blob20`,
 * `double1..double20`, and `index1`.
 */
export interface AnalyticsEngineDataPoint {
    /** String columns, mapped positionally to `blob1..blob20`. */
    blobs?: (ArrayBuffer | null | string)[];
    /** Numeric columns, mapped positionally to `double1..double20`. */
    doubles?: number[];
    /** Sampling key, exposed as `index1`. AE accepts at most one. */
    indexes?: (ArrayBuffer | string)[];
}

/**
 * Minimal structural projection of workers-types' `AnalyticsEngineDataset`,
 * kept loose enough for a plain-object fake in unit tests. `writeDataPoint` is
 * fire-and-forget: it returns `void` and never throws on the hot path.
 */
export interface AnalyticsEngineDatasetLike {
    writeDataPoint: (event: AnalyticsEngineDataPoint) => void;
}

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
 * this exact type as `import("@lunora/analytics").AnalyticsClient`). Telemetry
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

// ─── Pipelines (R2-backed streaming ingestion) ──────────────────────────────
//
// Pipelines ships from `@lunora/analytics` because it is the other "emit data
// to a sink" surface alongside Analytics Engine: telemetry/events out, no
// in-handler read-back. The binding is mirrored structurally (`*Like`) so a
// plain-object fake satisfies it in unit tests, like `AnalyticsEngineDatasetLike`.

/** One Pipelines record — a JSON object matching the stream's schema. */
export type PipelineRecord = Record<string, unknown>;

/**
 * Minimal structural projection of workers-types' `Pipeline&lt;T>` binding. The
 * real binding's `send` takes an array of records and resolves once accepted.
 */
export interface PipelineBindingLike<T extends PipelineRecord = PipelineRecord> {
    send: (records: T[]) => Promise<void>;
}

/**
 * The write-side client bound to `ctx.pipelines` (the generated context imports
 * this exact type as `import("@lunora/analytics").PipelineClient`). Ingestion is
 * durable, batched, and fire-and-forget — never read a record back in-handler.
 */
export interface PipelineClient<T extends PipelineRecord = PipelineRecord> {
    /** Ingest one record or an array of records into the R2-backed sink. */
    send: (records: T | T[]) => Promise<void>;
}
