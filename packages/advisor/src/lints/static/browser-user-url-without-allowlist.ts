import type { AdvisorBrowserUrlAccess } from "../../browser-url-accesses";
import type { Lint } from "../../types";
import { makeArgumentDerivedSinkLint } from "../argument-derived-sink";

/**
 * Flags a `ctx.browser.<method>(url, …)` call whose navigation URL is derived
 * from the handler's `args` with no server-side scoping — and no hardened
 * `createBrowser` allowlist to contain it.
 *
 * `@lunora/browser` blocks navigation to private/internal/loopback addresses by
 * default, but that guard only stops SSRF to *internal* targets. A
 * request-supplied *public* URL still turns the headless browser into an
 * open-proxy / request-forgery tool: any caller can make the deployment fetch
 * an arbitrary third-party URL (SSRF to public cloud APIs that trust the egress
 * IP, data exfiltration through the fetched URL), and — without pinned DNS — a
 * public hostname can rebind to an internal address after the guard's check.
 * The containment is an `allowedHosts` allowlist on `createBrowser`, or a
 * pinned `resolveDns: true`. This lint therefore suppresses all findings when
 * the config-call evidence shows a `createBrowser` hardened with either; only an
 * unhardened browser reaching an arg-derived URL is flagged. `resolveDns: false`
 * is NOT hardening — it turns the DoH re-check off — so it does not suppress.
 *
 * Runs only when the codegen feeder supplies browser URL-access evidence
 * (`context.browserUrlAccesses`); a runtime caller flags nothing. One finding
 * per arg-derived, unscoped `ctx.browser` navigation.
 */
const browserUserUrlWithoutAllowlist: Lint = makeArgumentDerivedSinkLint<AdvisorBrowserUrlAccess>({
    cacheKey: (access) => `browser_user_url_without_allowlist:${access.file}:${access.line.toString()}`,
    categories: ["SECURITY"],
    description:
        "A `ctx.browser.<method>(url, …)` call navigates to a URL derived from the handler's `args` with no server-side scoping, and no `createBrowser` allowlist contains it. The default guard blocks private targets but not arbitrary public URLs, so any caller can make the headless browser an open-proxy / SSRF tool (fetch arbitrary third-party URLs, DNS-rebind to internal hosts).",
    detail: (access) =>
        `\`ctx.browser.${access.method}\` in \`${access.exportName}\` (${access.file}:${access.line.toString()}) navigates to a URL derived from \`args\` with no server-side scoping, and no \`createBrowser\` allowlist contains it — the default guard blocks private targets but not arbitrary public URLs, so any caller can turn the headless browser into an open-proxy / SSRF tool. Pin \`allowedHosts\` (and/or \`resolveDns\`) on \`createBrowser({...})\`, and derive the URL from server-trusted state where possible.`,
    facing: "EXTERNAL",
    getAccesses: (context) => context.browserUrlAccesses,
    level: "WARN",
    metadata: (access) => {
        return { exportName: access.exportName, file: access.file, line: access.line, method: access.method };
    },
    name: "browser_user_url_without_allowlist",
    remediation:
        "Pin the browser with an `allowedHosts` allowlist (and/or `resolveDns`) on `createBrowser({...})`, and derive the navigation URL from server-trusted state where possible rather than passing `args` straight to `ctx.browser`.",
    // A `createBrowser` hardened with an `allowedHosts` allowlist or a pinned
    // `resolveDns: true` contains the SSRF surface — suppress every finding when
    // one is visible. Only an analyzable (non-spread, static object-literal)
    // config call counts; an opaque config could set the key elsewhere but can't
    // be relied on.
    //
    // `allowedHosts` is judged on PRESENCE and `resolveDns` on its VALUE, and the
    // asymmetry is deliberate rather than an oversight:
    //
    //  - Every `allowedHosts` value contains the surface, `[]` included:
    //    `@lunora/browser` treats an empty list as a configured allowlist with no
    //    members and refuses every navigation. (It used to read `[]` as "no
    //    allowlist" and permit every host, which made this presence test report
    //    containment that did not exist — the runtime, not this lint, was wrong.)
    //  - `resolveDns` has a value that switches the guard OFF. `resolveDns: false`
    //    is the documented way to skip the DoH re-check, and with no allowlist
    //    alongside it that leaves the navigation guarded by the string check
    //    alone — strictly less than the unconfigured default, which turns the
    //    re-check on. So only the literal `true` suppresses; `false`, or a value
    //    the feeder cannot read as `true`, leaves the finding standing.
    //
    // App-global on purpose, and sound because `ctx.browser` resolves from ONE
    // `browser: (env) => createBrowser(...)` config thunk: every navigation this
    // lint sees goes through that instance, so "a hardened createBrowser exists"
    // and "the instance behind ctx.browser is hardened" are the same statement.
    // A second `createBrowser` built for something else is not reachable as
    // `ctx.browser`, and requiring EVERY call to be hardened would flag
    // navigations that the allowlist does in fact contain.
    suppressWhen: (context) =>
        (context.configCalls ?? []).some(
            (call) => call.callee === "createBrowser" && call.analyzable && (call.presentKeys.includes("allowedHosts") || call.trueKeys.includes("resolveDns")),
        ),
    title: "Browser navigates to arg-derived URL with no allowlist",
});

export default browserUserUrlWithoutAllowlist;
