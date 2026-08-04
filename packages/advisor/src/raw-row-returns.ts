/* eslint-disable no-secrets/no-secrets -- the referenced lint rule id in the doc comment, not a credential */

/**
 * One `query` handler whose `return` hands back the raw rows of a table — the
 * result of a `ctx.db.<table>.findMany()` / `.findFirst()` / `.get()` read, or a
 * `ctx.db.query("<table>")…collect()` fluent chain — returned directly (or through
 * one local `const` hop) with no hand-built projection. The shared input for the
 * `output_projection_missing_on_public_read` lint, which keeps only `visibility
 * === "public"` rows with no `.output(...)` / `.use(mask(...))` on the chain and
 * joins `table` against the schema's PII-named columns before flagging. Produced by
 * the codegen feeder; runtime callers don't supply it, so the lint finds nothing
 * there. Structurally identical to `@lunora/codegen`'s `RawRowReturnIR`.
 */
export interface AdvisorRawRowReturn {
    /** The exported binding name of the query returning the raw rows. */
    exportName: string;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** 1-based line of the `return` (or concise-body) expression. */
    line: number;
    /** Table whose raw rows are returned, or `""` when the read's table couldn't be statically resolved. */
    table: string;
    /** `true` when the procedure's builder chain carries a `.use(mask(...))` step. */
    usesMask: boolean;
    /** `true` when the procedure's builder chain carries an `.output(...)` return-shape projection. */
    usesOutput: boolean;
    /** `"internal"` for `internalQuery`; `"public"` for `query`. */
    visibility: "internal" | "public";
}

/* eslint-enable no-secrets/no-secrets -- re-enable after the AdvisorRawRowReturn doc block */
