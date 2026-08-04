/**
 * Structural types for the Cloudflare Pipelines write path (R2-backed streaming
 * ingestion). Pipelines is the other "emit data to a sink" surface alongside
 * Analytics Engine — telemetry/events out, no in-handler read-back. The binding
 * is mirrored structurally (`*Like`) so a plain-object fake satisfies it in unit
 * tests, like `@lunora/bindings/analytics`'s `AnalyticsEngineDatasetLike`.
 */

/** One Pipelines record — a JSON object matching the stream's schema. */
export type PipelineRecord = Record<string, unknown>;

/**
 * Minimal structural projection of workers-types' `Pipeline<T>` binding. The
 * real binding's `send` takes an array of records and resolves once accepted.
 */
export interface PipelineBindingLike<T extends PipelineRecord = PipelineRecord> {
    send: (records: T[]) => Promise<void>;
}

/**
 * The write-side client bound to `ctx.pipelines` (the generated context imports
 * this exact type as `import("@lunora/bindings/pipelines").PipelineClient`).
 * Ingestion is durable, batched, and fire-and-forget — never read a record back
 * in-handler.
 */
export interface PipelineClient<T extends PipelineRecord = PipelineRecord> {
    /** Ingest one record or an array of records into the R2-backed sink. */
    send: (records: T | T[]) => Promise<void>;
}
