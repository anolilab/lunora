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

/** One durable step call lifted from a workflow handler body — the input the duplicate-step-name lint compares. Structural subset of codegen's `WorkflowStepIR`. */
export interface AdvisorWorkflowStep {
    /** 1-based line of the durable step call, or `0` when unknown. */
    line: number;
    /** The native step method invoked: `do` / `sleep` / `sleepUntil` / `waitForEvent`. */
    method: string;
    /** The step's static label (the first string-literal argument). */
    name: string;
}

/** One workflow declared via a `defineWorkflow()` export in `lunora/workflows.ts`. */
export interface AdvisorWorkflow {
    /** The `lunora/workflows.ts` export name, e.g. `orderPipeline`. */
    exportName: string;

    /**
     * The durable step labels discovered in the handler body, in source order —
     * the duplicate-step-name input. Cloudflare memoizes a step by its name, so a
     * name used twice makes the second call silently return the first's cached
     * result. Supplied by the codegen feeder; `undefined` for runtime callers,
     * where the lint finds nothing.
     */
    steps?: ReadonlyArray<AdvisorWorkflowStep>;
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
