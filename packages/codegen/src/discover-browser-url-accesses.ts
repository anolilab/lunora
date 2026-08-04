import type { Project } from "ts-morph";

import { discoverArgumentDerivedAccesses } from "./discover-argument-derived-accesses";
import type { BrowserUrlAccessIR } from "./ir";

/**
 * The `ctx.browser.<method>(url, …)` navigation methods whose first argument is
 * the URL to fetch. All four take the target URL as `arguments[0]`; the
 * page-driving `page.goto(url)` low-level method has a different receiver (a
 * page handle, not `ctx.browser`) and is not matched here.
 */
const BROWSER_URL_METHODS = new Set(["content", "pdf", "scrape", "screenshot"]);

/**
 * Discover `ctx.browser.<method>(url, …)` calls in `lunora/` whose navigation
 * URL is derived from the handler's `args` with no server-side scoping — the
 * `browser_user_url_without_allowlist` lint input. `@lunora/browser` blocks
 * private/internal targets by default, but a request-supplied *public* URL can
 * still turn the headless browser into an open-proxy / SSRF tool (fetching
 * arbitrary third-party URLs, DNS-rebinding to internal hosts). The lint pairs
 * this evidence with `createBrowser` config-call evidence, suppressing findings
 * when the browser is hardened with an `allowedHosts` allowlist or `resolveDns`.
 * A fixed literal URL, or one scoped by a server-trusted `ctx.*` value, is not
 * recorded; only an arg-derived, unscoped URL (directly, or through one local
 * `const` hop) reaches here.
 */
const discoverBrowserUrlAccesses = (project: Project, lunoraDirectory: string): BrowserUrlAccessIR[] =>
    discoverArgumentDerivedAccesses(project, lunoraDirectory, {
        argIndex: 0,
        matchReceiver: (receiver) => receiver === "ctx.browser",
        methods: BROWSER_URL_METHODS,
    });

export default discoverBrowserUrlAccesses;
