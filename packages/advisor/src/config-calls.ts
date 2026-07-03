/**
 * One factory/constructor call in `lunora/` whose configuration object literal a
 * security lint inspects for a present-or-absent key — the shared input for the
 * config-call security lints (payment authorize, inbound-mail verify, rate-limit
 * store, browser private-targets).
 *
 * The feeder records the callee name and, when the config argument is a static
 * object literal it could read, the set of keys present and the subset assigned
 * the literal `true`. Produced by the codegen feeder; runtime callers don't
 * supply it, so the config-call lints find nothing there.
 */
export interface AdvisorConfigCall {
    /**
     * `true` when the call's config argument was a static object literal the
     * feeder could read. `false` when the config was opaque (a variable, spread,
     * call result, or missing argument) — key-presence lints skip such calls so
     * a config assembled elsewhere can't be flagged on a key it may well set.
     */
    analyzable: boolean;
    /** The factory function or constructor name at the call site, e.g. `createPayment` / `RateLimiter`. */
    callee: string;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** 1-based line of the call site, or `0` when unknown. */
    line: number;
    /** Keys present in the config object literal (empty when not `analyzable`). */
    presentKeys: ReadonlyArray<string>;
    /** Keys in the config object literal explicitly assigned the literal `true`. */
    trueKeys: ReadonlyArray<string>;
}
