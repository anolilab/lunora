/**
 * The public-REST surface contract (plan 167), shared by `@lunora/runtime` (which
 * ROUTES REST requests to procedures) and `@lunora/codegen` (which DESCRIBES the
 * exposed surface in the generated OpenAPI). Kept here — inlined into each
 * consumer's bundle — so the live router and the published spec can never drift on
 * the path/method mapping without a runtime dependency edge between the packages.
 * This shared derivation is exactly what makes "the published OpenAPI matches the
 * live REST surface" a structural guarantee rather than a hand-kept invariant.
 *
 * Zero-dependency by design (see the repo's `shared/` rules): only relative/builtin
 * imports, named exports, no `.js` extensions.
 */

/** URL prefix every opt-in REST endpoint lives under. Reserved (`/_lunora/*`), so it never collides with an app's own routes. */
const REST_PATH_PREFIX = "/_lunora/rest";

/** Procedure kinds that can be exposed over REST (`stream` cannot — it is a WebSocket surface). */
type RestFunctionKind = "action" | "mutation" | "query";

/**
 * Request headers whose presence means the response may be caller-specific.
 *
 * `Authorization` covers bearer/basic auth, `Cookie` covers session cookies, and
 * `Cf-Access-Jwt-Assertion` covers Cloudflare Access — which
 * `@lunora/cloudflare-access` reads BEFORE its cookie, so a service-token or
 * machine client presents the header and no cookie. Omitting it would classify
 * those callers as anonymous.
 *
 * This list is not, and cannot be, exhaustive: `resolveIdentity` receives the
 * whole `Request` and an app may authenticate on anything (`x-api-key`, a signed
 * query parameter, …). An app doing that must declare its own header names via
 * {@link RestCachePolicy.credentialHeaders}, or not mark the endpoint
 * `scope: "public"`.
 *
 * `x-payment` is here for a reason worth stating: an x402-tagged procedure is
 * paywalled INSIDE the dispatch, so a paid response that a shared cache stored
 * would be replayed to callers who never paid — together with the payer's
 * settlement receipt. Treating the payment as the credential it is keeps the paid
 * exchange out of the shared cache entirely.
 *
 * One credential is deliberately absent because it is not a header at all: under
 * a Cloudflare Access policy attached to the Worker, the caller's identity
 * arrives on the `ExecutionContext`. `@lunora/runtime`'s `requestCarriesCredentials`
 * checks for that separately.
 */
const CREDENTIAL_HEADERS = ["authorization", "cf-access-jwt-assertion", "cookie", "x-payment"] as const;

/**
 * Headers that select WHICH data a request sees rather than who is asking, and so
 * must key the cache even though they aren't credentials. `x-lunora-shard-key`
 * routes to a shard (the query-string form is already in the URL, the header form
 * is not); `x-d1-bookmark` pins read-your-writes freshness. Without these in
 * `Vary`, one URL maps to many different bodies.
 */
const DATA_SELECTING_HEADERS = ["x-d1-bookmark", "x-lunora-shard-key"] as const;

/**
 * Declared HTTP caching for an exposed endpoint (`.expose({ cache })`). Lives
 * here, alongside the path/method contract, for the same reason: the runtime
 * WRITES these headers and the OpenAPI emitter DESCRIBES them, and the two must
 * not be able to disagree. Deriving both from {@link cacheControlValue} /
 * {@link cacheVaryValue} makes "the published spec matches what the runtime
 * actually sends" structural rather than a hand-kept invariant.
 */
interface RestCachePolicy {
    /**
     * Extra request headers this app authenticates on, beyond
     * {@link CREDENTIAL_HEADERS}. Declare these whenever `resolveIdentity` reads
     * something else (`x-api-key`, a tenant header, …): they join both the
     * credential check and the emitted `Vary`. Without them, a caller
     * authenticating that way is treated as anonymous.
     */
    readonly credentialHeaders?: ReadonlyArray<string>;
    readonly maxAge: number;
    readonly scope: "private" | "public";
    readonly staleWhileRevalidate?: number;
    readonly tag?: string;
    readonly vary?: string;
}

/** Every header name that must be treated as identifying for a given policy. */
const credentialHeadersFor = (policy: RestCachePolicy): string[] => [
    ...CREDENTIAL_HEADERS,
    ...(policy.credentialHeaders ?? []).map((name) => name.toLowerCase()),
];

/**
 * The `.expose({ rest: true })` tag stamped onto a registered procedure (runtime,
 * as `fn.expose`) or discovered from its builder chain (codegen, onto the
 * `FunctionIR`). Presence of `rest === true` is the ONLY thing that opts a
 * procedure into the surface — everything is default-closed.
 */
interface RestExposure {
    cache?: RestCachePolicy;
    rest?: boolean;
}

/** Clamp an author-supplied seconds value to a non-negative integer; a non-finite value degrades to `0` rather than emitting `NaN`. */
const cacheSeconds = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);

/**
 * Merge `Vary` header names case-insensitively, preserving first-seen order and
 * dropping duplicates. Returns `undefined` when nothing survives.
 */
const mergeVary = (...sources: ReadonlyArray<string | undefined>): string | undefined => {
    const names: string[] = [];

    for (const source of sources) {
        for (const raw of source?.split(",") ?? []) {
            const name = raw.trim().toLowerCase();

            if (name !== "" && !names.includes(name)) {
                names.push(name);
            }
        }
    }

    return names.length === 0 ? undefined : names.join(", ");
};

/**
 * The `Cache-Control` value for a policy under an EFFECTIVE scope — which the
 * runtime narrows per request (a credentialed caller is always `private`) and the
 * emitter documents as the declared best case. Both go through here, so the
 * clamping applies identically to the served header and the published example.
 */
const cacheControlValue = (policy: RestCachePolicy, effectiveScope: "private" | "public"): string => {
    const directives = [effectiveScope, `max-age=${String(cacheSeconds(policy.maxAge))}`];

    if (policy.staleWhileRevalidate !== undefined) {
        directives.push(`stale-while-revalidate=${String(cacheSeconds(policy.staleWhileRevalidate))}`);
    }

    return directives.join(", ");
};

/**
 * The `Vary` value a policy implies. Keyed off the DECLARED scope, not the
 * effective one: the point is to fence a stored anonymous variant off from
 * credentialed callers, and that fence has to be present on the anonymous
 * response itself. {@link DATA_SELECTING_HEADERS} are always included, since they
 * change the body regardless of scope.
 *
 * Treat `Vary` as a courtesy to well-behaved intermediaries, NOT as the safety
 * mechanism: Cloudflare's own cache honours `Vary` only for `Accept-Encoding`, so
 * the real protection is the credential downgrade in `@lunora/runtime`'s
 * `rest-cache`, which never emits `public` for an identified caller in the first
 * place.
 */
const cacheVaryValue = (policy: RestCachePolicy): string | undefined =>
    policy.scope === "public"
        ? mergeVary(policy.vary, ...credentialHeadersFor(policy), ...DATA_SELECTING_HEADERS)
        : mergeVary(policy.vary, ...DATA_SELECTING_HEADERS);

/** One resolved REST endpoint: the transport method + URL path a procedure is reachable at. */
interface RestSurfaceEntry {
    functionPath: string;
    kind: RestFunctionKind;
    method: "GET" | "POST";
    name: string;
    namespace: string;
    path: string;
}

/**
 * Split a `<namespace>:<function>` procedure path into its parts. Returns
 * `undefined` for a malformed path (no single colon separator) so callers skip it
 * rather than mint a broken route.
 */
const splitFunctionPath = (functionPath: string): { name: string; namespace: string } | undefined => {
    const colon = functionPath.indexOf(":");

    if (colon <= 0 || colon >= functionPath.length - 1 || functionPath.indexOf(":", colon + 1) !== -1) {
        return undefined;
    }

    return { name: functionPath.slice(colon + 1), namespace: functionPath.slice(0, colon) };
};

/** The REST URL path for a procedure: `/_lunora/rest/<namespace>/<function>`. */
const restPathForFunction = (functionPath: string): string | undefined => {
    const parts = splitFunctionPath(functionPath);

    if (parts === undefined) {
        return undefined;
    }

    return `${REST_PATH_PREFIX}/${parts.namespace}/${parts.name}`;
};

/**
 * The primary HTTP method for a procedure kind: a `query` is a safe read → `GET`
 * (args ride the query string; the router also accepts `POST` with a JSON body for
 * large arg sets), a `mutation` / `action` is a state change → `POST`.
 */
const restMethodForKind = (kind: RestFunctionKind): "GET" | "POST" => (kind === "query" ? "GET" : "POST");

/**
 * Resolve the full REST surface from a list of procedures, filtering to the ones
 * opted in via `.expose({ rest: true })`. The single source of truth both the
 * runtime router and the OpenAPI emitter derive from — a `stream` procedure or a
 * malformed path is skipped. Ordered by path for stable enumeration.
 *
 * Ordered by UTF-16 code unit, NOT `localeCompare` — for the reason
 * `shared/schema-snapshot.ts`'s `sortKeys` spells out: `localeCompare` resolves
 * against the runtime's default locale and ICU version, so it is not stable
 * across machines. That is not cosmetic here. The published OpenAPI document is
 * generated on one machine and the router enumerates the same surface on
 * another, and a contract test asserts the two match.
 */
const describeRestSurface = (
    procedures: ReadonlyArray<{ exposure?: RestExposure; functionPath: string; kind: "action" | "mutation" | "query" | "stream" }>,
): RestSurfaceEntry[] => {
    const entries: RestSurfaceEntry[] = [];

    for (const procedure of procedures) {
        if (procedure.exposure?.rest !== true || procedure.kind === "stream") {
            continue;
        }

        const parts = splitFunctionPath(procedure.functionPath);
        const path = restPathForFunction(procedure.functionPath);

        if (parts === undefined || path === undefined) {
            continue;
        }

        entries.push({
            functionPath: procedure.functionPath,
            kind: procedure.kind,
            method: restMethodForKind(procedure.kind),
            name: parts.name,
            namespace: parts.namespace,
            path,
        });
    }

    entries.sort((a, b) => (a.path < b.path ? -1 : Number(a.path > b.path)));

    return entries;
};

export type { RestCachePolicy, RestExposure, RestFunctionKind, RestSurfaceEntry };
export {
    cacheControlValue,
    cacheSeconds,
    cacheVaryValue,
    CREDENTIAL_HEADERS,
    credentialHeadersFor,
    DATA_SELECTING_HEADERS,
    describeRestSurface,
    mergeVary,
    REST_PATH_PREFIX,
    restMethodForKind,
    restPathForFunction,
    splitFunctionPath,
};
