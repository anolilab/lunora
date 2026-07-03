/**
 * One `ctx.ai.run(model, …)` call whose model-id argument is derived from the
 * handler's `args` with no server-side scoping — the input the
 * `ai_raw_run_escape_hatch` lint consumes. `ctx.ai.run` is the raw Workers AI
 * binding passthrough, bypassing the typed `ctx.ai.model(...)` + AI-SDK layer
 * (`generateText`/`streamText`/…) that caps output and enforces a schema. When
 * the model id comes straight from request input, any caller can select an
 * arbitrary model. A fixed literal model, or one scoped by a server-trusted
 * `ctx.*` value, is *not* recorded; only an arg-derived, unscoped model id
 * reaches here — an arg-derived `inputs` argument is normal usage and is never
 * inspected. Produced by the codegen feeder; runtime callers don't supply it,
 * so the lint finds nothing there.
 */
export interface AdvisorAiRawRun {
    /** The exported binding name of the procedure performing the `ctx.ai.run` call. */
    exportName: string;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** 1-based line of the `ctx.ai.run` call, or `0` when unknown. */
    line: number;
}
