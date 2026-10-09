import type { AdvisorCallSiteScope } from "./call-site-scope";

/**
 * One call-site edge of the architecture graph — the input the
 * `dispatch_cycle` lint consumes. The shape mirrors codegen's `CallEdgeIR`
 * exactly (the `CallSiteScope` is this same type), so the feeder list passes
 * straight through without conversion; the lint reads only the `call` /
 * `schedule` rows with a `target`.
 *
 * A `target` is the `namespace:export` function key (`api.billing.invoices.create`
 * → `billing_invoices:create`) for `call` / `schedule`; a queue or topic export
 * name for `enqueue` / `publish`. `reason` says why the target could not be
 * read statically, in which case `target` is absent.
 *
 * `conditional` is set (only ever to `true`) when the call sits behind
 * something that may not run — a guard, a loop, a `try`, an optional chain, a
 * ternary/logical right operand, or a statement an earlier early-exit shadows.
 * The cycle lint reads it as its false-positive gate: a cycle containing ANY
 * conditional edge is not an infinite loop, so only cycles whose every edge is
 * unconditional are flagged.
 *
 * Produced by the codegen feeder; runtime callers don't supply it, so the lint
 * finds nothing there.
 */
export interface AdvisorCallEdge {
    /** `true` when the call may not run on every pass — any guard between it and the module top. */
    conditional?: true;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** What the edge draws: a function call, a scheduled dispatch, an enqueue, a publish, or a service use. */
    kind: "call" | "enqueue" | "invoke" | "publish" | "schedule";
    /** 1-based line of the call, or `0` when unknown. */
    line: number;
    /** Why the target could not be read statically — set exactly when `target` is absent. */
    reason?: string;
    /** Who the site runs on behalf of — see {@link AdvisorCallSiteScope}. */
    scope: AdvisorCallSiteScope;
    /** The `namespace:export` function key (or queue/topic/service name) the edge points at. */
    target?: string;
}
