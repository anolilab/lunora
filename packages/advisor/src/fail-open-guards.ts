/**
 * One rate-limit / Turnstile middleware call — the `ratelimit_middleware_fail_open`
 * lint input. `rateLimit`/`dbRateLimit` (`@lunora/ratelimit`) and
 * `verifyTurnstileMiddleware` (`@lunora/auth`) each accept a `failOpen` escape
 * hatch that admits every request when the limiter/siteverify is unavailable;
 * `failOpen` is `true` only when the options literal set it to the boolean
 * literal `true` (anything else is fail-closed). The lint escalates a fail-open
 * guard to a finding when the guarded procedure (`exportName`/`limitName`) looks
 * auth/payment-sensitive. Produced by the codegen feeder; runtime callers don't
 * supply it, so the lint finds nothing there.
 */
export interface AdvisorFailOpenGuard {
    /** The middleware factory at the call site: `rateLimit` / `dbRateLimit` / `verifyTurnstileMiddleware`. */
    callee: string;
    /** The exported binding name of the procedure the guard is attached to, or `"<module>"` at file scope. */
    exportName: string;
    /** `true` only when the options literal set `failOpen: true` as a boolean literal; a non-literal or absent option is treated as fail-closed. */
    failOpen: boolean;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** The rate-limit `name` (second string argument) for `rateLimit`/`dbRateLimit`; `""` for `verifyTurnstileMiddleware`. */
    limitName: string;
    /** 1-based line of the middleware call, or `0` when unknown. */
    line: number;
}
