/**
 * Who is allowed to hand this worker a trace to join.
 *
 * Continuing an inbound W3C `traceparent` is what makes a distributed waterfall
 * stitch end to end, but the header is caller-supplied: on a public worker,
 * trusting it lets anyone choose which trace their spans and `ctx.log` lines land
 * in, and — because `shared/sampling` derives the head verdict from the trace id —
 * choose their own sampling outcome. Whether that matters is a *deployment*
 * question ("can an untrusted client reach this worker directly?"), which no
 * amount of request inspection can answer on its own.
 *
 * So rather than ask users to hand-roll a security predicate, this module ships
 * the handful of answers that are actually sound, named:
 *
 * ```ts
 * createWorker({ trustInboundTraceContext: "mtls" });                       // one signal
 * createWorker({ trustInboundTraceContext: ["mtls", "cloudflare-access"] }); // either
 * createWorker({ trustInboundTraceContext: true });                          // internal deployments
 * createWorker({ trustInboundTraceContext: (request) => … });                // escape hatch
 * ```
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
 * A named trust signal.
 *
 * - `"mtls"` — the caller presented a client certificate that **Cloudflare
 * verified at the edge**. This is the strongest option: `cf.tlsClientAuth` is
 * set by the platform and cannot be forged by the client.
 * - `"cloudflare-access"` — the request carries a Cloudflare Access identity
 * assertion. Sound **only when the deployment actually sits behind Access**, in
 * which case nothing reaches the worker without passing it. On a worker that is
 * also reachable directly, the header proves nothing — a client can set it. Pick
 * this to say "I am behind Access"; pick `"mtls"` if you need the check itself to
 * carry the proof.
 */
type TraceTrustSignal = "cloudflare-access" | "mtls";

/**
 * How much of the inbound trace context to trust. `false` (the default) ignores
 * it entirely; `true` trusts every caller and suits an internal-only deployment.
 */
type TrustInboundTraceContext = boolean | TraceTrustSignal | TraceTrustSignal[] | ((request: Request) => boolean);

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
    // Access sets this on every request it lets through. See the caveat on the
    // `TraceTrustSignal` docs: this is a declaration that Access fronts the worker.
    "cloudflare-access": (request) => request.headers.get("cf-access-jwt-assertion") !== null,
    // Edge-verified client certificate — the platform sets `certVerified`, so
    // unlike a header this cannot be spoofed by the caller.
    mtls: (request) => cfString(request, "tlsClientAuth", "certVerified") === "SUCCESS",
};

/**
 * Collapse a {@link TrustInboundTraceContext} into a single predicate, once, at
 * worker construction. An array is an **any-of**: the trace is continued when any
 * listed signal matches.
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

    const signals = new Set<string>(Array.isArray(option) ? option : [option]);
    // Driven from the known table rather than from the caller's list, so a value
    // that is not a real signal (a typo from a JS caller, where the union is not
    // enforced) simply matches nothing and the trace stays untrusted.
    const checks = Object.entries(SIGNAL_CHECKS)
        .filter(([signal]) => signals.has(signal))
        .map(([, check]) => check);

    return (request) => checks.some((check) => check(request));
};

/**
 * Build the "you had an upstream trace and we dropped it" notice.
 *
 * Ignoring the header is silent by construction, which is the kind of thing
 * someone loses an afternoon to — the waterfall is simply broken with nothing to
 * search for. This fires **at most once per worker** and only when a trace
 * actually arrived and was dropped, so it is a hint on the way to a working setup
 * rather than per-request noise.
 *
 * Setting the option explicitly to `false` silences it: that says the decision was
 * made deliberately, whereas leaving it unset says nobody has considered it yet.
 */
const createDroppedTraceNotice = (option: TrustInboundTraceContext | undefined): (() => void) => {
    // An explicit `false` is a decision; `undefined` is an unanswered question.
    if (option !== undefined) {
        return () => {};
    }

    let notified = false;

    return () => {
        if (notified) {
            return;
        }

        notified = true;

        // eslint-disable-next-line no-console -- a one-shot setup hint; the alternative is an invisible broken waterfall.
        console.warn(
            "[lunora] Ignored an inbound `traceparent`, so this request starts a new trace instead of joining the caller's. " +
                "That is the safe default: the header is caller-supplied, and trusting it lets any client choose which trace its spans and logs join. " +
                "If this worker sits behind a gateway, service mesh, or Cloudflare Access that sets `traceparent` itself, set " +
                '`trustInboundTraceContext` on createWorker() — `true`, or a signal like `"mtls"` / `"cloudflare-access"`. ' +
                "Set it to `false` to keep this behaviour and silence this message.",
        );
    };
};

export type { TraceTrustSignal, TrustInboundTraceContext };
export { createDroppedTraceNotice, resolveTraceTrust };
