import type { AdvisorCallSiteScope } from "./call-site-scope";

/**
 * One literal-infinite loop in `lunora/` source with no statically reachable
 * exit — the input the `unbounded_loop` lint consumes. Produced by the codegen
 * feeder, which records `while (true)`, `for (;;)` / `for (; true;)` and
 * `do { … } while (true)` only when no `break` bound to the loop, no
 * `return`/`throw` leaving its function, and no `yield` suspending it exists.
 * A loop guarded by any other condition is never recorded. The shape mirrors
 * codegen's `UnboundedLoopIR`, so the feeder list passes straight through.
 * Runtime callers don't supply it, so the lint finds nothing there.
 */
export interface AdvisorUnboundedLoop {
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** The loop form that never falls out. */
    kind: "do" | "for" | "while";
    /** 1-based line of the loop keyword. */
    line: number;
    /** Who the loop runs on behalf of — see {@link AdvisorCallSiteScope}. */
    scope: AdvisorCallSiteScope;
}
