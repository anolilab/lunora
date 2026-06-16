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

/** Per-header overrides for {@link SecurityHeadersOptions}. `false` omits the header. */
interface SecurityHeadersOptions {
    /**
     * `Content-Security-Policy`. Omitted (`undefined`) applies a restrictive
     * default to **non-HTML** responses only, so an SSR page is never broken by
     * a policy it didn't opt into. Pass a string to apply that policy to every
     * response (HTML included); `false` to never send one.
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
    csp: { htmlToo: boolean; value: string } | undefined;
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
    maxAge: number;
}

interface ResolvedCsrf {
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

const DEFAULT_PERMISSIONS_POLICY =
    "accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()";

const DEFAULT_CORS_HEADERS = ["Authorization", "Content-Type", "X-D1-Bookmark", "X-Lunora-Mutation-Id"];

const DEFAULT_CORS_METHODS = ["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT"];

const ONE_YEAR_SECONDS = 31_536_000;

/** Methods that never mutate state and so are exempt from the CSRF/origin guard. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const resolveHstsHeader = (hsts: SecurityHeadersOptions["hsts"]): string | undefined => {
    if (hsts === false) {
        return undefined;
    }

    const config = hsts === undefined || hsts === true ? {} : hsts;
    const maxAge = config.maxAge ?? ONE_YEAR_SECONDS;
    const includeSubDomains = config.includeSubDomains ?? true;

    return `max-age=${String(maxAge)}${includeSubDomains ? "; includeSubDomains" : ""}${config.preload ? "; preload" : ""}`;
};

const resolveCspHeader = (csp: SecurityHeadersOptions["csp"]): ResolvedHeaders["csp"] => {
    if (csp === false) {
        return undefined;
    }

    if (typeof csp === "string") {
        return { htmlToo: true, value: csp };
    }

    return { htmlToo: false, value: DEFAULT_CSP };
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

    return {
        coop: "same-origin",
        csp: resolveCspHeader(options.csp),
        enabled: true,
        frameOptions: options.frameOptions === false ? undefined : (options.frameOptions ?? "SAMEORIGIN"),
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
        maxAge: 600,
    };

    if (input === undefined || input === false) {
        return disabled;
    }

    const allowCredentials = input.allowCredentials ?? false;
    const origins = input.allowedOrigins;
    const rawList = Array.isArray(origins) ? origins : undefined;

    if (rawList?.includes("*") && allowCredentials) {
        throw new Error(
            '@lunora/runtime: security.cors cannot combine a wildcard origin ("*") with allowCredentials: true — browsers reject it and it defeats the allowlist.',
        );
    }

    const isAllowed = typeof origins === "function" ? origins : (origin: string): boolean => origins.includes("*") || origins.includes(origin);

    return {
        allowCredentials,
        allowedHeaders: input.allowedHeaders ?? DEFAULT_CORS_HEADERS,
        allowedMethods: input.allowedMethods ?? DEFAULT_CORS_METHODS,
        enabled: true,
        isAllowed,
        maxAge: input.maxAge ?? 600,
    };
};

const resolveCsrf = (input: boolean | CsrfOptions | undefined): ResolvedCsrf => {
    if (input === false) {
        return { enabled: false, trustedOrigins: [] };
    }

    const options: CsrfOptions = input === undefined || input === true ? {} : input;

    return { enabled: true, trustedOrigins: options.trustedOrigins ?? [] };
};

/** Env values that read as "disable this layer" for the `LUNORA_SECURITY_*` opt-out vars. */
const DISABLED_ENV_VALUES = new Set(["0", "disabled", "false", "no", "off"]);

/** Env values that read as "on" for a boolean-ish flag like `LUNORA_CORS_ALLOW_CREDENTIALS`. */
const ENABLED_ENV_VALUES = new Set(["1", "enabled", "on", "true", "yes"]);

/** True when an env var is explicitly set to a disable value (`off`, `false`, `0`, …). */
const isEnvDisabled = (value: unknown): boolean => typeof value === "string" && DISABLED_ENV_VALUES.has(value.trim().toLowerCase());

/** True when an env var is explicitly set to an enable value (`on`, `true`, `1`, …). */
const isEnvEnabled = (value: unknown): boolean => typeof value === "string" && ENABLED_ENV_VALUES.has(value.trim().toLowerCase());

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
 * relaxes or fills the secure default, and the DO security audit (which reads the
 * same vars) and the running worker stay in agreement.
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

/** Origin component of a URL string (e.g. a `Referer`), or `undefined` if unparseable. */
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

/** Whether `origin` is same-origin, an explicitly trusted origin, or a CORS-allowed origin. */
const isTrustedOrigin = (origin: string, selfOrigin: string, resolved: ResolvedSecurity): boolean => {
    if (origin === selfOrigin) {
        return true;
    }

    if (resolved.csrf.trustedOrigins.includes(origin)) {
        return true;
    }

    return resolved.cors.enabled && resolved.cors.isAllowed(origin);
};

/**
 * CSRF defense: reject an unsafe (state-changing), **cookie-authenticated**
 * request whose `Origin`/`Referer` is neither same-origin nor allowlisted.
 *
 * Scoped deliberately to cookie-bearing browser requests — the only vector a
 * cross-site forgery can ride, since a browser auto-attaches cookies but never a
 * bearer token or custom header. Bearer/server-to-server traffic (no `Cookie`)
 * is exempt, as are safe methods. Returns a `403` `Response` to short-circuit,
 * or `undefined` when the request may proceed.
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

    return Response.json(
        { error: { code: "FORBIDDEN_ORIGIN", message: "cross-origin state-changing request rejected" } },
        { headers: { "content-type": "application/json" }, status: 403 },
    );
};

/** Build the `Access-Control-Allow-*` headers for an allowed cross-origin request. */
const corsResponseHeaders = (origin: string, cors: ResolvedCors): Headers => {
    const headers = new Headers();

    headers.set("access-control-allow-origin", origin);
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
    headers.set("access-control-allow-headers", requested ?? resolved.cors.allowedHeaders.join(", "));
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

    if (config.csp !== undefined && (config.csp.htmlToo || !isHtmlResponse(response))) {
        setIfAbsent(headers, "content-security-policy", config.csp.value);
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
export { decorateResponse, enforceOrigin, handleCorsPreflight, resolveSecurity };
