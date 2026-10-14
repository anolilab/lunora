/* eslint-disable no-secrets/no-secrets -- the referenced lint rule id in the doc comment, not a credential */

/**
 * One `ctx.flags` read discovered lexically inside a `query(...)` handler body —
 * the input the `flag_read_in_subscription` lint consumes. Produced by the
 * codegen feeder, which walks each exported query's handler with ts-morph and
 * records reads of the flag-evaluation surface (`ctx.flags.boolean(...)`,
 * `ctx.flags.string(...)`, `ctx.flags.details.number(...)`, …).
 *
 * A flag read is a point-in-time evaluation, and nothing about it is *wrong* —
 * but the invalidation system does not model it. Flipping a flag appends nothing
 * to `__cdc_log`, so no live subscription is re-run: a query that branched on a
 * flag keeps serving the branch it picked when it last ran, for as long as the
 * client stays subscribed. The reactive path is `useFlag`, which is served
 * through the flags function prefix and re-evaluated on every write-flush.
 *
 * `mutation(...)` and `action(...)` handlers are intentionally **not** recorded —
 * neither backs a live subscription, so a flag read there is evaluated once for a
 * call that also happens once, and there is no staleness to warn about. Runtime
 * callers don't supply this, so the lint finds nothing there.
 */
export interface AdvisorFlagRead {
    /** The accessed `ctx.flags` surface, e.g. `ctx.flags.boolean` / `ctx.flags.details.string`. */
    callee: string;
    /** The exported query performing the read (e.g. `listMessages`). */
    exportName: string;
    /** Source file the read appears in (relative to the lunora dir, no extension). */
    file: string;
    /** 1-based line of the read, or `0` when unknown. */
    line: number;
}

/* eslint-enable no-secrets/no-secrets -- re-enable after the AdvisorFlagRead doc block */
