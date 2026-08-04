/**
 * One `ctx.browser.<method>(url, …)` call whose navigation URL (`arguments[0]`)
 * is derived from the handler's `args` with no server-side scoping — the input
 * the `browser_user_url_without_allowlist` lint consumes. `@lunora/browser`
 * blocks private/internal targets by default, but a request-supplied *public*
 * URL can still turn the headless browser into an open-proxy / SSRF tool
 * (fetching arbitrary third-party URLs, DNS-rebinding to internal hosts). A
 * fixed literal URL, or one scoped by a server-trusted `ctx.*` value, is not
 * recorded; only an arg-derived, unscoped URL reaches here. Produced by the
 * codegen feeder; runtime callers don't supply it, so the lint finds nothing
 * there.
 */
export interface AdvisorBrowserUrlAccess {
    /** The exported binding name of the procedure performing the `ctx.browser` call. */
    exportName: string;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** 1-based line of the `ctx.browser` call, or `0` when unknown. */
    line: number;
    /** The browser method invoked: `content` / `pdf` / `scrape` / `screenshot`. */
    method: string;
}
