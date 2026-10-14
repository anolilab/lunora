/**
 * Who is allowed to hand this worker a trace to join.
 *
 * Continuing an inbound W3C `traceparent` is what makes a distributed waterfall
 * stitch end to end, but the header is caller-supplied: on a public worker,
 * trusting it lets anyone choose which trace their spans and `ctx.log` lines land
 * in — and, since a trusted upstream is also what makes the head verdict key on
 * that caller-supplied TRACE id, choose their own sampling outcome. (Untrusted,
 * the verdict keys on the server-minted span id instead, which is precisely the
 * hole this option closes.) Whether that matters is a *deployment* question
 * ("can an untrusted client reach this worker directly?"), which no amount of
 * request inspection can answer on its own.
 *
 * So rather than ask users to hand-roll a security predicate, this module ships
 * the answers that are actually sound, named:
 *
 * ```ts
 * createWorker({ trustInboundTraceContext: true });            // nothing untrusted can reach this worker
 * createWorker({ trustInboundTraceContext: "mtls" });          // only edge-verified client certs
 * createWorker({ trustInboundTraceContext: (request) => … });  // anything else
 * ```
 *
 * **Behind a gateway, mesh, or Cloudflare Access, `true` is the answer.** If the
 * worker is genuinely unreachable except through that front door, every caller
 * has already passed it and there is nothing left to discriminate on. Check that
 * it really is unreachable — a `*.workers.dev` route left enabled, or a hostname
 * outside the Access policy, is a second front door with no gate on it.
 *
 * There is deliberately no `"cloudflare-access"` signal. Recognising Access by its
 * `cf-access-jwt-assertion` header only tests that a header is present, which is
 * redundant when the worker is properly fronted (`true` already covers it) and
 * forgeable in one `curl` when it is not. Verifying the assertion for real means a
 * JWKS fetch and an audience check — `@lunora/cloudflare-access` does exactly
 * that, and it is async, so it belongs in `resolveIdentity` rather than on the
 * dispatch path. Pass a predicate if you want to wire it in yourself.
 *
 * Everything resolves to one predicate at worker construction, so the per-request
 * cost is a single call.
 *
 * The custom form receives only the `Request`, deliberately: handing user code the
 * Worker `env` would put every secret binding behind a telemetry callback, the
 * same boundary `LogSinkContext` was just narrowed to avoid. A predicate that
 * needs to compare against a binding should close over it — build the worker per
 * request from an options factory, the pattern `createLunoraHandler` already uses.
 */

/**
 * A named trust signal — a per-request property that, on its own, establishes the
 * caller is one whose trace context may be adopted.
 *
 * - `"mtls"` — the caller presented a client certificate that **Cloudflare
 * verified at the edge**. `cf.tlsClientAuth` is platform-injected request
 * metadata, not a header, so a caller cannot write it: the check carries its own
 * proof and holds regardless of how the worker is exposed.
 *
 * Signals live here only when they meet that bar. A property a client can set for
 * itself is not a signal; see the module doc on why Cloudflare Access is absent.
 */
type TraceTrustSignal = "mtls";

/**
 * How much of the inbound trace context to trust. `false` (the default) ignores
 * it entirely; `true` trusts every caller, which is right when nothing untrusted
 * can reach the worker.
 */
type TrustInboundTraceContext = boolean | TraceTrustSignal | ((request: Request) => boolean);

/** Read a nested string off the loosely-typed Cloudflare `request.cf` bag. */
const cfString = (request: Request, ...path: string[]): string | undefined => {
    let current: unknown = (request as { cf?: unknown }).cf;

    for (const key of path) {
        if (typeof current !== "object" || current === null) {
            return undefined;
        }

        current = (current as Record<string, unknown>)[key];
    }

    return typeof current === "string" ? current : undefined;
};

/** Predicate for each named signal. */
const SIGNAL_CHECKS: Record<TraceTrustSignal, (request: Request) => boolean> = {
    // Edge-verified client certificate — the platform sets `certVerified`, so
    // unlike a header this cannot be spoofed by the caller.
    mtls: (request) => cfString(request, "tlsClientAuth", "certVerified") === "SUCCESS",
};

/**
 * Collapse a {@link TrustInboundTraceContext} into a single predicate, once, at
 * worker construction.
 */
const resolveTraceTrust = (option: TrustInboundTraceContext | undefined): ((request: Request) => boolean) => {
    if (option === undefined || option === false) {
        return () => false;
    }

    if (option === true) {
        return () => true;
    }

    if (typeof option === "function") {
        return option;
    }

    // Looked up in the known table rather than trusted from the caller, so a value
    // that is not a real signal (a typo from a JS caller, where the union is not
    // enforced) matches nothing and the trace stays untrusted rather than throwing
    // on the dispatch path.
    return (Object.hasOwn(SIGNAL_CHECKS, option) ? SIGNAL_CHECKS[option] : undefined) ?? (() => false);
};

/** Whether a {@link TrustInboundTraceContext} is one of the named signals. */
const isTraceTrustSignal = (option: TrustInboundTraceContext | undefined): option is TraceTrustSignal =>
    typeof option === "string" && Object.hasOwn(SIGNAL_CHECKS, option);

/**
 * Build the "you had an upstream trace and we dropped it" notice.
 *
 * Ignoring the header is silent by construction, which is the kind of thing
 * someone loses an afternoon to — the waterfall is simply broken with nothing to
 * search for. This fires **at most once per worker** and only when a trace
 * actually arrived and was dropped, so it is a hint on the way to a working setup
 * rather than per-request noise.
 *
 * Two different silences are covered, and only one is a decision:
 *
 * - **The option was never set.** Nobody has considered whether this worker's
 * callers are trustworthy. Setting it explicitly to `false` silences this.
 * - **A named signal cannot be satisfied on this host.** Every signal reads
 * PLATFORM-INJECTED request metadata (`request.cf`), which a non-Cloudflare
 * host does not provide — so `"mtls"` collapses to "never trust" and the
 * operator gets the default they explicitly opted out of. There is no
 * `PlatformCapabilities` gate that can catch this (the option is a
 * `createWorker` argument, invisible to codegen), so this is the only place it
 * can be seen at all. A host that DOES inject the metadata never warns: a
 * caller without a verified certificate is then the option working as asked.
 */
const createDroppedTraceNotice = (option: TrustInboundTraceContext | undefined): ((request: Request) => void) => {
    const signal = isTraceTrustSignal(option) ? option : undefined;

    // An explicit `false`/`true`/predicate is a decision; `undefined` is an
    // unanswered question, and a signal has its own (host-support) arm below.
    if (option !== undefined && signal === undefined) {
        return () => {};
    }

    let notified = false;

    return (request: Request) => {
        if (notified) {
            return;
        }

        // The signal's metadata bag is present, so the signal is live and a
        // caller that failed it is the configured behaviour, not a misconfiguration.
        if (signal !== undefined && (request as { cf?: unknown }).cf !== undefined) {
            return;
        }

        notified = true;

        // eslint-disable-next-line no-console -- a one-shot setup hint; the alternative is an invisible broken waterfall.
        console.warn(
            signal === undefined
                ? "[lunora] Ignored an inbound `traceparent`, so this request starts a new trace instead of joining the caller's. " +
                      "That is the safe default: the header is caller-supplied, and trusting it lets any client choose which trace its spans and logs join. " +
                      "If this worker sits behind a gateway, service mesh, or Cloudflare Access that sets `traceparent` itself, set " +
                      '`trustInboundTraceContext: true` on createWorker() (or `"mtls"` to trust only edge-verified client certificates). ' +
                      "Set it to `false` to keep this behaviour and silence this message."
                : `[lunora] \`trustInboundTraceContext: "${signal}"\` cannot be satisfied on this host: the request carries no platform-injected ` +
                      "`cf` metadata, which is what that signal reads, so every inbound `traceparent` is ignored and this request starts a new trace. " +
                      "Off Cloudflare, trust the upstream some other way — `trustInboundTraceContext: true` when nothing untrusted can reach this " +
                      "worker, or a predicate that verifies whatever your own front door sets. Set it to `false` to keep this behaviour and silence " +
                      "this message.",
        );
    };
};

export type { TraceTrustSignal, TrustInboundTraceContext };
export { createDroppedTraceNotice, resolveTraceTrust };
