/**
 * Secure-by-default HTTP edge for the Lunora worker.
 *
 * The worker's top-level `fetch` (see `./create-worker`) is the single choke
 * point every response passes through — RPC, auth, admin, `httpRoute` handlers,
 * and the SSR fallback alike. This module supplies what is applied there:
 * `decorateResponse` adds baseline security headers plus, for allowed
 * cross-origin requests, the matching `Access-Control-Allow-*` headers (never
 * overwriting a header the inner handler set); `handleCorsPreflight` answers
 * `OPTIONS` preflights for allowlisted origins; `enforceOrigin` is a CSRF guard
 * that rejects state-changing, cookie-authenticated requests from untrusted
 * origins.
 *
 * Every layer is on by default and individually disable-able through the
 * `SecurityOptions` passed to `createWorker`. Resolution (`resolveSecurity`) is
 * pure and platform-agnostic — it touches only the global `Request`/`Response`/
 * `Headers`/`URL`, so it unit-tests under plain Node without workerd.
 */

import { isEnvDisabled, isEnvEnabled } from "../../../shared/env-flag";
import { LunoraError } from "./errors";

/** Per-header overrides for {@link SecurityHeadersOptions}. `false` omits the header. */
interface SecurityHeadersOptions {
    /**
     * `Content-Security-Policy`. Omitted (`undefined`) applies a restrictive
     * `default-src 'none'` policy to **non-HTML** responses, and a conservative
     * hardening policy to **HTML** responses (`base-uri 'none'; frame-ancestors
     * 'self'; object-src 'none'`) — this does NOT set `default-src`/`script-src`,
     * so it never blocks an SSR page's own scripts/styles/images/fetches, it only
     * locks down the `base` element, framing (mirroring the `SAMEORIGIN`
     * X-Frame-Options default), and legacy plugins. Pass a string to apply that
     * exact policy to every response (HTML included); `false` to never send one.
     */
    csp?: string | false;
    /** `X-Frame-Options` (clickjacking). Defaults to `SAMEORIGIN`. `false` omits it. */
    frameOptions?: "DENY" | "SAMEORIGIN" | false;
    /** `Strict-Transport-Security`. Only ever sent over HTTPS. `false` omits it. */
    hsts?: boolean | { includeSubDomains?: boolean; maxAge?: number; preload?: boolean };
    /** `Permissions-Policy`. Defaults to a minimal deny list. `false` omits it. */
    permissionsPolicy?: string | false;
    /** `Referrer-Policy`. Defaults to `strict-origin-when-cross-origin`. `false` omits it. */
    referrerPolicy?: string | false;
}

/** CORS allowlist. Cross-origin is denied unless an origin matches. */
interface CorsOptions {
    /** Echo `Access-Control-Allow-Credentials: true`. Incompatible with a `*` allowlist. */
    allowCredentials?: boolean;
    /** Request headers permitted on the actual request (preflight `Allow-Headers`). */
    allowedHeaders?: string[];
    /** Methods permitted cross-origin (preflight `Allow-Methods`). */
    allowedMethods?: string[];
    /** Allowed origins — an explicit list (`"*"` permitted only without credentials) or a predicate. */
    allowedOrigins: string[] | ((origin: string) => boolean);
    /** Preflight cache lifetime in seconds (`Access-Control-Max-Age`). */
    maxAge?: number;
}

/** Origin/CSRF guard configuration. */
interface CsrfOptions {
    /**
     * Whether a loopback `Origin` is trusted **when the worker itself is serving on
     * loopback**. Defaults to `true`.
     *
     * This is the local-development shape: the browser loads the app from the dev
     * server on `localhost:3000` which proxies `/_lunora` to wrangler on
     * `localhost:8787`. With `changeOrigin`, the worker sees its own URL as
     * `:8787` while the browser's `Origin` stays `:3000`, so the two don't match and
     * the cookie-bearing WS upgrade is rejected — the app then hangs on its loading
     * state with no clue why. Both ends are loopback, so nothing cross-site can
     * reach them.
     *
     * It cannot loosen production: the exemption requires the worker's OWN origin to
     * be loopback, which a deployed worker's never is. Set `false` for a hardened
     * local setup that wants the strict same-origin rule.
     */
    allowLoopback?: boolean;
    /** Extra origins (beyond same-origin and the CORS allowlist) accepted on unsafe cookie requests. */
    trustedOrigins?: string[];
}

/**
 * The `security` option on `createWorker`. Every field is optional and defaults
 * to a secure posture; set a field to `false` to opt out of that layer.
 */
interface SecurityOptions {
    /** CORS. Defaults to **deny cross-origin**; supply an allowlist to permit specific origins. `false` disables CORS handling. */
    cors?: CorsOptions | false;
    /** CSRF/origin guard for unsafe, cookie-authenticated requests. `true`/object = on (default), `false` = off. */
    csrf?: boolean | CsrfOptions;
    /** Baseline security response headers. `true`/object = on (default), `false` = off. */
    headers?: boolean | SecurityHeadersOptions;
}

interface ResolvedHeaders {
    coop: string | undefined;
    csp: { htmlValue: string | undefined; value: string } | undefined;
    enabled: boolean;
    frameOptions: string | undefined;
    hsts: string | undefined;
    permissionsPolicy: string | undefined;
    referrerPolicy: string | undefined;
}

interface ResolvedCors {
    allowCredentials: boolean;
    allowedHeaders: string[];
    allowedMethods: string[];
    enabled: boolean;
    isAllowed: (origin: string) => boolean;

    /**
     * Like {@link ResolvedCors.isAllowed} but NEVER satisfied by a wildcard `*`
     * allowlist — an origin counts only when matched by an explicit, non-wildcard
     * rule (a named origin in the list, or a custom predicate the developer
     * wrote). Used by the CSRF guard: a wildcard CORS allowlist means "any origin
     * may read my non-credentialed responses", which must NOT be conflated with
     * "I trust any origin to make authenticated state changes".
     */
    isExplicitlyAllowed: (origin: string) => boolean;
    maxAge: number;
}

interface ResolvedCsrf {
    allowLoopback: boolean;
    enabled: boolean;
    trustedOrigins: string[];
}

/** Normalized, ready-to-apply security configuration. */
interface ResolvedSecurity {
    cors: ResolvedCors;
    csrf: ResolvedCsrf;
    headers: ResolvedHeaders;
}

const DEFAULT_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * Conservative default CSP for HTML responses, derived from the resolved
 * `frameOptions` so the two framing controls agree — a static `frame-ancestors
 * 'self'` would otherwise *weaken* an `X-Frame-Options: DENY` policy, since
 * modern browsers prefer CSP `frame-ancestors` over the legacy header.
 * Deliberately omits `default-src`/`script-src`/`style-src`/`connect-src`/
 * `form-action` so it never breaks an SSR page's own resources or cross-origin
 * form posts (e.g. OAuth redirects); it only locks the `base` element's href,
 * forbids legacy plugins, and mirrors the framing policy: `DENY` → `'none'`,
 * `SAMEORIGIN` → `'self'`, disabled (`frameOptions: false`) → no
 * `frame-ancestors` (framing left unrestricted, matching the absent header).
 * Operators wanting a strict HTML policy pass an explicit `csp` string.
 */
const htmlCspFor = (frameOptions: string | undefined): string => {
    const parts = ["base-uri 'none'", "object-src 'none'"];

    if (frameOptions === "DENY") {
        parts.push("frame-ancestors 'none'");
    } else if (frameOptions === "SAMEORIGIN") {
        parts.push("frame-ancestors 'self'");
    }

    return parts.join("; ");
};

const DEFAULT_PERMISSIONS_POLICY =
    "accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()";

/**
 * Request headers a cross-origin caller may send by default.
 *
 * This is the allowlist the preflight intersects against, with no wildcard, so
 * every header `@lunora/client` attaches on its own has to be here — a browser
 * blocks the whole request over one unlisted name. That makes the list part of
 * the client's wire contract, not a security knob to trim: each entry is a
 * header the SDK sends unprompted, and omitting one breaks exactly the apps
 * that configure `security.cors` (i.e. those on a separate frontend domain).
 */
const DEFAULT_CORS_HEADERS = [
    "Authorization",
    "Content-Type",
    "X-D1-Bookmark",
    "X-Lunora-Client-Id",
    "X-Lunora-Client-Seq",
    "X-Lunora-Min-Seq",
    "X-Lunora-Mutation-Id",
    // The REST surface's documented header form of `?shardKey=` (`rest-routes.ts`
    // reads it). Omitted, a browser SPA on an allowlisted origin that picked the
    // header over the query parameter was blocked at preflight.
    "X-Lunora-Shard-Key",
];

const DEFAULT_CORS_METHODS = ["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT"];

const ONE_YEAR_SECONDS = 31_536_000;

/** Methods that never mutate state and so are exempt from the CSRF/origin guard. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * @returns the HSTS header value string, or `undefined` when HSTS is disabled.
 */
const resolveHstsHeader = (hsts: SecurityHeadersOptions["hsts"]): string | undefined => {
    if (hsts === false) {
        return undefined;
    }

    const config = hsts === undefined || hsts === true ? {} : hsts;
    const maxAge = config.maxAge ?? ONE_YEAR_SECONDS;
    const includeSubDomains = config.includeSubDomains ?? true;

    return `max-age=${String(maxAge)}${includeSubDomains ? "; includeSubDomains" : ""}${config.preload ? "; preload" : ""}`;
};

/**
 * @returns the resolved CSP config object, or `undefined` when CSP is disabled.
 */
const resolveCspHeader = (csp: SecurityHeadersOptions["csp"], htmlDefault: string): ResolvedHeaders["csp"] => {
    if (csp === false) {
        return undefined;
    }

    if (typeof csp === "string") {
        return { htmlValue: csp, value: csp };
    }

    return { htmlValue: htmlDefault, value: DEFAULT_CSP };
};

const resolveHeaders = (input: boolean | SecurityHeadersOptions | undefined): ResolvedHeaders => {
    if (input === false) {
        return {
            coop: undefined,
            csp: undefined,
            enabled: false,
            frameOptions: undefined,
            hsts: undefined,
            permissionsPolicy: undefined,
            referrerPolicy: undefined,
        };
    }

    const options: SecurityHeadersOptions = input === undefined || input === true ? {} : input;
    // Resolve framing first so the default HTML CSP's `frame-ancestors` tracks it.
    const frameOptions = options.frameOptions === false ? undefined : (options.frameOptions ?? "SAMEORIGIN");

    return {
        coop: "same-origin",
        csp: resolveCspHeader(options.csp, htmlCspFor(frameOptions)),
        enabled: true,
        frameOptions,
        hsts: resolveHstsHeader(options.hsts),
        permissionsPolicy: options.permissionsPolicy === false ? undefined : (options.permissionsPolicy ?? DEFAULT_PERMISSIONS_POLICY),
        referrerPolicy: options.referrerPolicy === false ? undefined : (options.referrerPolicy ?? "strict-origin-when-cross-origin"),
    };
};

const resolveCors = (input: CorsOptions | false | undefined): ResolvedCors => {
    const disabled: ResolvedCors = {
        allowCredentials: false,
        allowedHeaders: DEFAULT_CORS_HEADERS,
        allowedMethods: DEFAULT_CORS_METHODS,
        enabled: false,
        isAllowed: () => false,
        isExplicitlyAllowed: () => false,
        maxAge: 600,
    };

    if (input === undefined || input === false) {
        return disabled;
    }

    const allowCredentials = input.allowCredentials ?? false;
    const origins = input.allowedOrigins;

    let isAllowed: (origin: string) => boolean;
    let isExplicitlyAllowed: (origin: string) => boolean;

    if (typeof origins === "function") {
        // A custom predicate is an explicit developer decision, so it counts for CSRF
        // trust in both directions.
        //
        // Wrapped ONCE here rather than at the three consumers (preflight, header
        // reflection, and the CSRF trusted-origin decision), all of which test it
        // truthily. It is app code: a predicate written as `origins.indexOf(o)` or
        // `TRUSTED.find(...)` returns a number or an object, and every non-`true`
        // truthy value would allow the origin.
        const allowsOrigin = (origin: string): boolean => (origins(origin) as unknown) === true;

        isAllowed = allowsOrigin;
        isExplicitlyAllowed = allowsOrigin;

        // A predicate bypasses the array path's wildcard+credentials guard, and it
        // is also assigned to `isExplicitlyAllowed` above — meaning the CSRF and
        // WebSocket origin checks trust it even when CORS credentials are off. An
        // over-broad predicate (e.g. `() => true`, or a loose `endsWith`) therefore
        // admits cookie-bearing form posts and WS upgrades from any origin — and,
        // with `allowCredentials: true`, additionally reflects any Origin with
        // credentials (the exact combo the array path forbids at construction).
        // We can't statically prove a predicate is safe, so warn loudly either way.
        const credentialsNote = allowCredentials ? " AND reflects matching origins with credentials (`allowCredentials: true`)" : "";

        // eslint-disable-next-line no-console -- surface a security-sensitive CORS configuration at construction
        console.warn(
            `@lunora/runtime: security.cors uses a custom \`allowedOrigins\` predicate. It is trusted by the CSRF and WebSocket origin checks${credentialsNote} — ensure it matches ONLY trusted origins by exact equality; an over-broad predicate (e.g. \`() => true\`, or \`endsWith\`/\`includes\` checks) defeats the allowlist.`,
        );
    } else {
        const originsList = origins;

        if (originsList.includes("*") && allowCredentials) {
            throw new LunoraError(
                '@lunora/runtime: security.cors cannot combine a wildcard origin ("*") with allowCredentials: true — browsers reject it and it defeats the allowlist.',
            );
        }

        // A list-based allowlist counts ONLY for the non-wildcard entries it names
        // (a `*` entry never confers CSRF trust for state-changing requests).
        isAllowed = (origin: string): boolean => originsList.includes("*") || originsList.includes(origin);
        isExplicitlyAllowed = (origin: string): boolean => originsList.includes(origin);
    }

    return {
        allowCredentials,
        allowedHeaders: input.allowedHeaders ?? DEFAULT_CORS_HEADERS,
        allowedMethods: input.allowedMethods ?? DEFAULT_CORS_METHODS,
        enabled: true,
        isAllowed,
        isExplicitlyAllowed,
        maxAge: input.maxAge ?? 600,
    };
};

const resolveCsrf = (input: boolean | CsrfOptions | undefined): ResolvedCsrf => {
    if (input === false) {
        return { allowLoopback: false, enabled: false, trustedOrigins: [] };
    }

    const options: CsrfOptions = input === undefined || input === true ? {} : input;

    return { allowLoopback: options.allowLoopback ?? true, enabled: true, trustedOrigins: options.trustedOrigins ?? [] };
};

/**
 * Build a {@link CorsOptions} from the deployment env when CORS isn't configured
 * in code. `LUNORA_ALLOWED_ORIGINS` is a comma-separated allowlist (a single `*`
 * permits any origin); `LUNORA_CORS_ALLOW_CREDENTIALS` echoes credentials.
 * Returns `undefined` when no allowlist is set, so the secure deny-by-default
 * stands.
 *
 * Unlike the code path (which throws on a wildcard paired with credentials, a
 * developer error worth failing fast), an env-driven wildcard+credentials is
 * **sanitized** to wildcard-without-credentials rather than thrown — the
 * combination is already rejected at build time by `@lunora/config` and flagged
 * by the DO security audit, and a throw here would 500 every request on a live
 * worker. Degrading to the safe interpretation keeps the deployment serving.
 * @returns the parsed CORS options, or `undefined` when no allowlist is configured.
 */
const parseEnvCors = (env: Record<string, unknown> | undefined): CorsOptions | undefined => {
    const raw = env?.["LUNORA_ALLOWED_ORIGINS"];

    if (typeof raw !== "string") {
        return undefined;
    }

    const allowedOrigins = raw
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0);

    if (allowedOrigins.length === 0) {
        return undefined;
    }

    const wildcard = allowedOrigins.includes("*");
    const allowCredentials = !wildcard && isEnvEnabled(env?.["LUNORA_CORS_ALLOW_CREDENTIALS"]);

    return { allowCredentials, allowedOrigins };
};

/**
 * Normalize the public {@link SecurityOptions} into the resolved form the
 * request path applies. Pure — throws only on an invalid combination (wildcard
 * CORS + credentials) so the misconfiguration surfaces at worker construction
 * rather than silently shipping an unenforceable policy.
 *
 * `env` supplies the deployment-level security vars: `LUNORA_SECURITY_HEADERS` /
 * `LUNORA_SECURITY_CSRF` opt out of those layers (set either to `off`/`false`/`0`),
 * and `LUNORA_ALLOWED_ORIGINS` / `LUNORA_CORS_ALLOW_CREDENTIALS` configure CORS
 * when it isn't set in code. **Code config wins** — an explicit `security.*` in
 * {@link SecurityOptions} overrides the matching env knob — so the env var only
 * relaxes or fills the secure default.
 *
 * That precedence is exactly why the two can disagree, so pick one place per
 * layer. The Durable Object's security audit (`buildSecurityAudit`) sees only
 * `env` — the DO has no view of what was passed to `createWorker` — so
 * `security: { headers: true }` in code plus an `off` value for
 * `LUNORA_SECURITY_HEADERS` in env leaves the worker applying the headers while the audit reports
 * `security-headers-disabled`, and the same holds for `csrf`. The audit is
 * reporting the deployment var honestly; it is not a claim about the resolved
 * worker. Setting a layer in code means leaving its env var unset.
 */
const resolveSecurity = (security: SecurityOptions | undefined, env?: Record<string, unknown>): ResolvedSecurity => {
    const headers = security?.headers ?? (isEnvDisabled(env?.["LUNORA_SECURITY_HEADERS"]) ? false : undefined);
    const csrf = security?.csrf ?? (isEnvDisabled(env?.["LUNORA_SECURITY_CSRF"]) ? false : undefined);
    const cors = security?.cors ?? parseEnvCors(env);

    return {
        cors: resolveCors(cors),
        csrf: resolveCsrf(csrf),
        headers: resolveHeaders(headers),
    };
};

/**
 * Origin component of a URL string (e.g. a `Referer`), or `undefined` if unparseable.
 * @returns the origin string, or `undefined` when `value` is null/empty/unparseable.
 */
/** Hostnames that can only ever be the local machine. */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

/**
 * Whether `origin` addresses the local machine. Matches `localhost`, IPv4
 * `127.0.0.1`, and IPv6 `[::1]` on any port/scheme.
 *
 * Deliberately narrow: a `*.localhost` subdomain or any other 127/8 address is NOT
 * matched, because those can be pointed at by public DNS and are a known way to
 * smuggle a "local" origin. Only the three canonical spellings count.
 */
const isLoopbackOrigin = (origin: string): boolean => {
    try {
        return LOOPBACK_HOSTNAMES.has(new URL(origin).hostname);
    } catch {
        return false;
    }
};

const originOf = (value: string | null): string | undefined => {
    if (!value) {
        return undefined;
    }

    try {
        return new URL(value).origin;
    } catch {
        return undefined;
    }
};

/**
 * Whether `origin` is same-origin, an explicitly trusted CSRF origin, or matched
 * by an **explicit, non-wildcard** CORS rule.
 *
 * A wildcard CORS allowlist (`*`) deliberately does NOT confer CSRF trust here:
 * "any origin may read my non-credentialed responses" is not "I trust any origin
 * to make authenticated state changes for my logged-in users". Use
 * `cors.isExplicitlyAllowed`, which never matches via a `*` entry, so a wildcard
 * CORS config cannot silently defeat the CSRF guard.
 */
const isTrustedOrigin = (origin: string, selfOrigin: string, resolved: ResolvedSecurity): boolean => {
    if (origin === selfOrigin) {
        return true;
    }

    if (resolved.csrf.trustedOrigins.includes(origin)) {
        return true;
    }

    // Dev-proxy exemption: both ends on loopback. Gated on the worker's OWN origin
    // being loopback too, so a deployed worker (whose origin never is) cannot reach
    // this branch. See `CsrfOptions.allowLoopback`.
    if (resolved.csrf.allowLoopback && isLoopbackOrigin(selfOrigin) && isLoopbackOrigin(origin)) {
        return true;
    }

    return resolved.cors.enabled && resolved.cors.isExplicitlyAllowed(origin);
};

/**
 * The 403 body for a rejected origin.
 *
 * Names the origin received, the origin expected, and the knob that fixes it. The
 * old body said only "cross-origin state-changing request rejected", which behind a
 * dev proxy is actively misleading: the request wasn't cross-*site*, the ports
 * simply differed, and there was nothing in the response pointing at
 * `security.csrf.trustedOrigins`.
 */
const forbiddenOriginResponse = (what: string, received: string | undefined, selfOrigin: string): Response =>
    Response.json(
        {
            error: {
                code: "FORBIDDEN_ORIGIN",
                expectedOrigin: selfOrigin,
                message:
                    `${what} rejected: Origin ${received === undefined ? "was missing" : `"${received}"`} is not trusted (this worker serves "${selfOrigin}"). ` +
                    "Add it to `security.csrf.trustedOrigins` (or LUNORA_ALLOWED_ORIGINS) if it is yours. " +
                    "Behind a dev proxy this usually means the proxy rewrote the host: keep both ends on loopback, or list the dev-server origin.",
                receivedOrigin: received,
            },
        },
        { headers: { "content-type": "application/json" }, status: 403 },
    );

/**
 * CSRF defense: reject an unsafe (state-changing), **cookie-authenticated**
 * request whose `Origin`/`Referer` is neither same-origin nor allowlisted.
 *
 * Scoped deliberately to cookie-bearing browser requests — the only vector a
 * cross-site forgery can ride, since a browser auto-attaches cookies but never a
 * bearer token or custom header. Bearer/server-to-server traffic (no `Cookie`)
 * is exempt, as are safe methods. Returns a `403` `Response` to short-circuit,
 * or `undefined` when the request may proceed.
 * @returns a `403` Response when the origin is untrusted, or `undefined` when the request is allowed.
 */
const enforceOrigin = (request: Request, resolved: ResolvedSecurity): Response | undefined => {
    if (!resolved.csrf.enabled || SAFE_METHODS.has(request.method) || !request.headers.get("cookie")) {
        return undefined;
    }

    const selfOrigin = new URL(request.url).origin;
    const source = originOf(request.headers.get("origin")) ?? originOf(request.headers.get("referer"));

    if (source !== undefined && isTrustedOrigin(source, selfOrigin, resolved)) {
        return undefined;
    }

    return forbiddenOriginResponse("cross-origin state-changing request", source, selfOrigin);
};

/**
 * CSRF defense for the WebSocket upgrade (Cross-Site WebSocket Hijacking).
 *
 * A WS handshake is an HTTP `GET`, so {@link enforceOrigin}'s safe-method
 * exemption never fires for it — yet the browser auto-attaches the session
 * cookie to the handshake and WebSocket connections are NOT governed by
 * CORS/SOP. Without an explicit `Origin` check any page can open
 * `wss://app/_lunora/ws`, authenticate as the logged-in victim, and read the
 * victim's live queries + issue mutations as them. This guard closes that hole.
 *
 * Scoped to cookie-bearing upgrades — the only vector CSWSH can ride (a browser
 * attaches cookies but never a bearer token). Bearer/token/server-to-server
 * upgrades (no `Cookie`) are exempt. A browser ALWAYS sends `Origin` on a WS
 * handshake, so a missing/untrusted `Origin` on a cookie-bearing upgrade fails
 * closed (mirrors {@link enforceOrigin}).
 * @returns a `403` Response when the upgrade origin is untrusted, or `undefined` when it is allowed.
 */
const enforceWebSocketOrigin = (request: Request, resolved: ResolvedSecurity): Response | undefined => {
    if (!resolved.csrf.enabled || !request.headers.get("cookie")) {
        return undefined;
    }

    const selfOrigin = new URL(request.url).origin;
    const source = originOf(request.headers.get("origin"));

    if (source !== undefined && isTrustedOrigin(source, selfOrigin, resolved)) {
        return undefined;
    }

    return forbiddenOriginResponse("cross-origin websocket upgrade", source, selfOrigin);
};

/**
 * Response headers a cross-origin caller may READ.
 *
 * A browser hides every response header except the CORS-safelisted ones unless
 * it is named here, and `response.headers.get(...)` then returns `null` with no
 * error anywhere. That failure is silent by construction, so this list is not a
 * policy knob: it is exactly the set of headers `@lunora/client` reads back,
 * and a header the SDK consumes but that is missing here does not break loudly
 * — it degrades the guarantee the header exists to provide.
 *
 * `x-d1-bookmark` carries D1 read-your-writes; `x-lunora-shard-key` is the
 * canonical shard a dispatch resolved to, which the client keys its replica
 * bookmark by; `x-lunora-edge-cache` is the REST edge-cache hit indicator, which
 * the docs tell callers to read and a browser could not otherwise see.
 */
const DEFAULT_CORS_EXPOSED_HEADERS = ["X-D1-Bookmark", "X-Lunora-Edge-Cache", "X-Lunora-Shard-Key"];

/** Build the `Access-Control-Allow-*` headers for an allowed cross-origin request. */
const corsResponseHeaders = (origin: string, cors: ResolvedCors): Headers => {
    const headers = new Headers();

    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-expose-headers", DEFAULT_CORS_EXPOSED_HEADERS.join(", "));
    headers.append("vary", "Origin");

    if (cors.allowCredentials) {
        headers.set("access-control-allow-credentials", "true");
    }

    return headers;
};

/**
 * Answer a CORS preflight (`OPTIONS` carrying `Access-Control-Request-Method`)
 * for an allowlisted origin with a `204`. Returns `undefined` for non-preflight
 * requests, a disabled CORS layer, or a disallowed origin — letting the request
 * fall through to normal routing.
 * @returns a `204` Response for valid preflights, or `undefined` to fall through.
 */
const handleCorsPreflight = (request: Request, resolved: ResolvedSecurity): Response | undefined => {
    if (!resolved.cors.enabled || request.method !== "OPTIONS") {
        return undefined;
    }

    const origin = request.headers.get("origin");

    if (!origin || !request.headers.get("access-control-request-method") || !resolved.cors.isAllowed(origin)) {
        return undefined;
    }

    const headers = corsResponseHeaders(origin, resolved.cors);
    const requested = request.headers.get("access-control-request-headers");

    headers.set("access-control-allow-methods", resolved.cors.allowedMethods.join(", "));

    // Enforce the configured allowlist rather than echoing the browser's
    // requested headers verbatim: intersect the requested list against
    // `allowedHeaders` case-insensitively (preserving the requested casing),
    // so a client can never widen the advertised set beyond what the developer
    // permitted. `allowedHeaders` has no wildcard support, so none is honored.
    let allowedHeaders: string;

    if (requested === null) {
        allowedHeaders = resolved.cors.allowedHeaders.join(", ");
    } else {
        const permitted = new Set(resolved.cors.allowedHeaders.map((name) => name.toLowerCase()));

        allowedHeaders = requested
            .split(",")
            .map((name) => name.trim())
            .filter((name) => name.length > 0 && permitted.has(name.toLowerCase()))
            .join(", ");
    }

    headers.set("access-control-allow-headers", allowedHeaders);
    headers.set("access-control-max-age", String(resolved.cors.maxAge));

    // eslint-disable-next-line unicorn/no-null -- the Fetch API requires `null` (not `undefined`) for an empty 204 body
    return new Response(null, { headers, status: 204 });
};

const isHtmlResponse = (response: Response): boolean => (response.headers.get("content-type") ?? "").toLowerCase().includes("text/html");

/** Set `name` only if the response doesn't already carry it — inner handlers win. */
const setIfAbsent = (headers: Headers, name: string, value: string): void => {
    if (!headers.has(name)) {
        headers.set(name, value);
    }
};

/** Layer the baseline security headers onto `headers`, respecting per-header opt-outs. */
const applyBaselineHeaders = (headers: Headers, request: Request, response: Response, config: ResolvedHeaders): void => {
    // HSTS is meaningful only over HTTPS; sending it on `http://localhost` would
    // pin dev to HTTPS and break local development.
    if (config.hsts !== undefined && new URL(request.url).protocol === "https:") {
        setIfAbsent(headers, "strict-transport-security", config.hsts);
    }

    setIfAbsent(headers, "x-content-type-options", "nosniff");

    if (config.frameOptions !== undefined) {
        setIfAbsent(headers, "x-frame-options", config.frameOptions);
    }

    if (config.referrerPolicy !== undefined) {
        setIfAbsent(headers, "referrer-policy", config.referrerPolicy);
    }

    if (config.permissionsPolicy !== undefined) {
        setIfAbsent(headers, "permissions-policy", config.permissionsPolicy);
    }

    if (config.coop !== undefined) {
        setIfAbsent(headers, "cross-origin-opener-policy", config.coop);
    }

    if (config.csp !== undefined) {
        // HTML responses get the (possibly conservative) HTML policy; everything
        // else gets the strict policy. `htmlValue` may be undefined only in
        // future configs that opt HTML out entirely.
        const cspValue = isHtmlResponse(response) ? config.csp.htmlValue : config.csp.value;

        if (cspValue !== undefined) {
            setIfAbsent(headers, "content-security-policy", cspValue);
        }
    }
};

/** Layer the `Access-Control-Allow-*` headers onto `headers` for an allowed origin. */
const applyCorsHeaders = (headers: Headers, request: Request, cors: ResolvedCors): void => {
    const origin = request.headers.get("origin");

    if (!origin || !cors.isAllowed(origin)) {
        return;
    }

    for (const [name, value] of corsResponseHeaders(origin, cors).entries()) {
        if (name === "vary") {
            headers.append("vary", value);
        } else {
            setIfAbsent(headers, name, value);
        }
    }
};

/**
 * Apply baseline security headers and (for allowed cross-origin requests) CORS
 * headers to an outgoing response, without overwriting anything the inner
 * handler already set.
 *
 * WebSocket upgrade responses (`status 101` / a `webSocket` field) are returned
 * untouched: re-wrapping them in a new `Response` would drop the socket and the
 * hibernation handshake.
 */
const decorateResponse = (response: Response, request: Request, resolved: ResolvedSecurity): Response => {
    // `webSocket` is set on a Cloudflare upgrade Response (absent under Node's
    // undici, where it reads back `undefined`).
    if (response.status === 101 || (response as { webSocket?: unknown }).webSocket) {
        return response;
    }

    const headers = new Headers(response.headers);

    if (resolved.headers.enabled) {
        applyBaselineHeaders(headers, request, response, resolved.headers);
    }

    if (resolved.cors.enabled) {
        applyCorsHeaders(headers, request, resolved.cors);
    }

    return new Response(response.body, { headers, status: response.status, statusText: response.statusText });
};

export type { CorsOptions, CsrfOptions, ResolvedSecurity, SecurityHeadersOptions, SecurityOptions };
export { decorateResponse, enforceOrigin, enforceWebSocketOrigin, handleCorsPreflight, resolveSecurity };
