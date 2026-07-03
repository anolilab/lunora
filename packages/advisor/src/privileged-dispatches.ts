/**
 * One payload-derived privileged dispatch — a `ctx.run`/`context.run` back into a
 * Lunora function from inside a `defineQueue` push handler or a `defineWorkflow`
 * handler, whose args reference the handler's untrusted payload (`context.params`
 * for a workflow, a `for (… of batch.messages)` body for a queue) — the input the
 * `privileged_dispatch_unvalidated_payload` lint consumes. Both handler kinds run
 * under the **system identity** (RLS disabled), so forwarding attacker-influenced
 * payload into the dispatch skips the target's row policy. The lint joins the
 * resolved `targetFile`/`targetExport` against the RLS-procedure evidence and
 * fires only when the target enforces RLS. Produced by the codegen feeder;
 * runtime callers don't supply it, so the lint finds nothing there.
 */
export interface AdvisorPrivilegedDispatch {
    /** `"queue"` for a `defineQueue` handler, `"workflow"` for a `defineWorkflow` handler. */
    dispatchKind: "queue" | "workflow";
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** The exported handler binding performing the dispatch. */
    handlerExport: string;
    /** 1-based line of the dispatch call, or `0` when unknown. */
    line: number;
    /** Export name of the dispatched target (`send` in `api.messages.send`). */
    targetExport: string;
    /** File path of the dispatched target relative to the lunora dir (`messages` in `api.messages.send`). */
    targetFile: string;
}
