import type { AdvisorBrowserUrlAccess } from "../../browser-url-accesses";
import type { Lint } from "../../types";
import { makeArgumentDerivedSinkLint } from "../argument-derived-sink";
import { callSiteFields, callSiteWhere } from "../helpers";

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
 * The containment is an `allowedHosts` allowlist on `createBrowser`, which
 * Browser Run enforces on the session itself; it is the supported production
 * posture. Without it the guard is a best-effort Worker-side check (the DoH
 * re-check included, `resolveDns: true` or not), so this lint suppresses its
 * findings only when the config-call evidence shows a `createBrowser` with
 * `allowedHosts`.
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
        `\`ctx.browser.${access.method}\` in ${callSiteWhere(access)} navigates to a URL derived from \`args\` with no server-side scoping, and no \`createBrowser\` allowlist contains it — the default guard blocks private targets but not arbitrary public URLs, so any caller can turn the headless browser into an open-proxy / SSRF tool. Pin \`allowedHosts\` on \`createBrowser({...})\` (Browser Run enforces it on the session), and derive the URL from server-trusted state where possible.`,
    facing: "EXTERNAL",
    getAccesses: (context) => context.browserUrlAccesses,
    level: "WARN",
    metadata: (access) => {
        return { ...callSiteFields(access), method: access.method };
    },
    name: "browser_user_url_without_allowlist",
    remediation:
        "Pin the browser with an `allowedHosts` allowlist on `createBrowser({...})` — Browser Run enforces it on the session, which makes it the supported production posture — and derive the navigation URL from server-trusted state where possible rather than passing `args` straight to `ctx.browser`.",
    // Only `allowedHosts` contains the surface, judged on PRESENCE: every value,
    // `[]` included, is enforced (`@lunora/browser` treats an empty list as an
    // allowlist with no members, and Browser Run's guardrails carry it).
    // `resolveDns: true` no longer suppresses: the DoH re-check is the default
    // anyway, and without an allowlist the whole guard is a best-effort
    // Worker-side check (see the package's "Production posture" docs), which is
    // exactly the posture this finding should keep visible.
    //
    // Only an analyzable (non-spread, static object-literal) config call counts;
    // an opaque config could set the key elsewhere but can't be relied on.
    //
    // App-global on purpose, and sound because `ctx.browser` resolves from ONE
    // `browser: (env) => createBrowser(...)` config thunk: every navigation this
    // lint sees goes through that instance, so "a hardened createBrowser exists"
    // and "the instance behind ctx.browser is hardened" are the same statement.
    suppressWhen: (context) =>
        (context.configCalls ?? []).some((call) => call.callee === "createBrowser" && call.analyzable && call.presentKeys.includes("allowedHosts")),
    title: "Browser navigates to arg-derived URL with no allowlist",
});

export default browserUserUrlWithoutAllowlist;
