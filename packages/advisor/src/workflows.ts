/**
 * The two workflow-shaped inputs the `workflow_*` lints consume, produced by the
 * codegen feeder. {@link AdvisorWorkflow} is the declaration side (one per
 * `defineWorkflow` export in `lunora/workflows.ts`); {@link AdvisorWorkflowCall}
 * is the use side (one per `ctx.workflows.get("name")` call discovered in a
 * function body). Runtime callers don't supply either, so the workflow lints
 * simply find nothing there.
 *
 * Both are structural subsets of codegen's `WorkflowIR` / `WorkflowCallIR`, so
 * the feeder passes the IR arrays straight through without conversion (mirrors
 * how `AdvisorContainer` tracks `ContainerIR` and `AdvisorInsertWrite` tracks
 * `InsertWriteIR`).
 */

/** One workflow declared via a `defineWorkflow()` export in `lunora/workflows.ts`. */
export interface AdvisorWorkflow {
    /** The `lunora/workflows.ts` export name, e.g. `orderPipeline`. */
    exportName: string;
}

/** One `ctx.workflows.get("name")` call discovered in a function body. */
export interface AdvisorWorkflowCall {
    /** The exported function performing the call (e.g. `create`). */
    exportName: string;
    /** Source file the call appears in (relative to the lunora dir, no extension). */
    file: string;
    /** 1-based line of the `get(...)` call, or `0` when unknown. */
    line: number;
    /** The referenced workflow export name; empty when the `get(...)` argument is not a string literal. */
    workflow: string;
}
