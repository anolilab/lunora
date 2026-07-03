/**
 * One `ctx.fetch(url, …)` call inside an action whose URL argument is derived
 * from the handler's `args` — the input the `action_fetch_ssrf` lint consumes.
 * `ctx.fetch` is the action-only outbound-request escape hatch with no host
 * allowlist, so a URL assembled from request input is a server-side request
 * forgery vector (cloud metadata endpoints, internal services). A fixed literal
 * URL, or one built from config/`ctx.*`, is *not* recorded; only an arg-derived
 * URL reaches here. Produced by the codegen feeder; runtime callers don't supply
 * it, so the lint finds nothing there.
 */
export interface AdvisorArgumentDerivedFetch {
    /** The exported binding name of the action performing the `ctx.fetch` call. */
    exportName: string;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** 1-based line of the `ctx.fetch` call, or `0` when unknown. */
    line: number;
}
