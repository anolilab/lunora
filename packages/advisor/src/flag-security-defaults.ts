/**
 * One `ctx.flags.boolean("key", <boolean-literal>)` read — the
 * `flag_gates_security_with_unsafe_default` lint input. OpenFeature returns the
 * `defaultValue` when the provider errors, so a fail-open default on a
 * security-shaped key (an `enforce`/`rls`/`gate`/`lockdown` protection
 * defaulting `false`, or an `allow`/`permit`/`bypass` permission defaulting
 * `true`) silently opens access during an outage. Only reads with a
 * statically-known string key and boolean-literal default are recorded; the lint
 * owns the security-shape + polarity judgment. Produced by the codegen feeder;
 * runtime callers don't supply it, so the lint finds nothing there.
 */
export interface AdvisorFlagSecurityDefault {
    /** The boolean-literal default returned on a provider outage (fail-open value). */
    defaultValue: boolean;
    /** The exported binding name of the procedure performing the flag read, or `"<module>"` at file scope. */
    exportName: string;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** The flag key — the first string-literal argument of `ctx.flags.boolean`. */
    key: string;
    /** 1-based line of the `ctx.flags.boolean` call, or `0` when unknown. */
    line: number;
}
