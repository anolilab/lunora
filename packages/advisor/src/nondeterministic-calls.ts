/**
 * One non-deterministic API call discovered lexically inside a `query(...)` or
 * `mutation(...)` handler body — the input the `nondeterministic_query_mutation`
 * lint consumes. Produced by the codegen feeder, which walks each exported
 * function's handler with ts-morph and records calls to `Date.now`,
 * `Math.random`, `crypto.randomUUID`, `crypto.getRandomValues`, and `fetch`.
 * Calls inside `action(...)` handlers are intentionally **not** recorded — actions
 * are the determinism escape hatch. Runtime callers don't supply this, so the
 * lint finds nothing there.
 */
export interface AdvisorNondeterministicCall {
    /** The non-deterministic API invoked, e.g. `Date.now` / `Math.random` / `crypto.randomUUID` / `fetch`. */
    callee: string;
    /** The exported function performing the call (e.g. `sendMessage`). */
    exportName: string;
    /** Source file the call appears in (relative to the cirrus dir, no extension). */
    file: string;
    /** Which procedure kind the call lives in — only `query`/`mutation` handlers are non-deterministic; actions are exempt. */
    kind: "mutation" | "query";
    /** 1-based line of the call, or `0` when unknown. */
    line: number;
}
