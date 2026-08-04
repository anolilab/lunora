import { LunoraError } from "@lunora/errors";

import type { LunoraAuth } from "./create-auth";

/**
 * Structural mirror of `@lunora/server`'s `MiddlewareNext` — the continuation
 * callback handed to a middleware. Repeated here so this package does not take
 * a runtime dependency on `@lunora/server`; the types are assignable from the
 * fully-typed builder.
 */
interface MiddlewareNext<ContextIn> {
    (): Promise<ContextIn>;
    <Extension extends Record<string, unknown>>(options: { ctx: Extension }): Promise<ContextIn & Extension>;
}

/**
 * Decide whether a `ctx.authApi.*` call carried `headers`. Mirrors the static
 * advisor's `hasHeaders` rule (`@lunora/codegen`'s `discover-authapi-calls`) so
 * the runtime guard and the lint agree on what counts as a header-bearing call:
 *
 * - **No argument at all** → no headers (the lint flags `method()`).
 * - **An object argument** → require a `headers` property to be present
 * (the lint flags `method({ body })` but not `method({ body, headers })`).
 * A nullish `headers` value still counts as "absent" — passing
 * `headers: undefined` is the same bypass as omitting it.
 * - **A non-object argument** (a pre-bound options variable, a call, …) →
 * treated as header-bearing. The static lint under-reports here too
 * ("can't prove headers is absent → don't flag"); we mirror that rather than
 * risk false positives on a security guard.
 */
const callHasHeaders = (argument: unknown): boolean => {
    if (argument === undefined) {
        return false;
    }

    if (typeof argument !== "object" || argument === null) {
        // Can't prove headers is absent → don't throw (mirrors the lint).
        return true;
    }

    const { headers } = argument as { headers?: unknown };

    return headers !== undefined && headers !== null;
};

/**
 * Wrap a better-auth `api` surface in a Proxy that throws
 * {@link LunoraAuthHeadersError} when any endpoint is invoked without `headers`.
 *
 * The proxy is transparent: property reads return guarded function wrappers for
 * callable endpoints and pass everything else (non-function properties) through
 * untouched, so the wrapped surface stays structurally identical to `auth.api`.
 *
 * One synthetic property is added — `withoutHeaders()` — the explicit, loud
 * escape hatch that returns the raw, unguarded `auth.api` for the rare,
 * deliberate server-to-server call that must run unauthenticated.
 */
const guardAuthApi = <Api extends Record<string, unknown>>(api: Api): Api => {
    const withoutHeaders = (): Api => api;

    return new Proxy(api, {
        // eslint-disable-next-line sonarjs/function-return-type -- a Proxy `get` trap is intrinsically polymorphic: it returns the synthetic `withoutHeaders`, the guarded endpoint wrapper, or any passthrough property value
        get(target, property, receiver) {
            // The explicit opt-out: `ctx.authApi.withoutHeaders()` returns the
            // raw, unguarded surface. We only synthesise it when the underlying
            // api doesn't already define a real endpoint by that name, so a
            // future better-auth `withoutHeaders` endpoint would win.
            if (property === "withoutHeaders" && !(property in target)) {
                return withoutHeaders;
            }

            const value = Reflect.get(target, property, receiver);

            if (typeof value !== "function" || typeof property !== "string") {
                return value;
            }

            const method = property;

            return (...arguments_: unknown[]): unknown => {
                if (!callHasHeaders(arguments_[0])) {
                    // better-auth endpoints are async, so surface the guard as a
                    // rejected promise — it composes with `await`/`.catch` the
                    // same way an endpoint error would, instead of throwing
                    // synchronously during the call expression.
                    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- only invoked inside a deferred endpoint closure, long after the class is defined; declared after the helpers to keep exports grouped at end of file
                    return Promise.reject(new LunoraAuthHeadersError(method));
                }

                // Call with `target` as `this` so endpoints that read other
                // properties off the api object still resolve them.
                return Reflect.apply(value as (...a: unknown[]) => unknown, target, arguments_);
            };
        },
    });
};

/**
 * Thrown by the runtime header guard when a privileged `ctx.authApi.*` endpoint
 * is invoked without a `headers` property on its argument object. Carries the
 * offending `method` name so callers can pinpoint the bad call site, and points
 * at the explicit escape hatches.
 *
 * This is the runtime sibling of the static `auth_api_call_without_headers`
 * advisor lint — both treat a header-less `ctx.authApi.*` call as an
 * authorization bypass, so a call that trips the lint also trips this guard.
 */
export class LunoraAuthHeadersError extends LunoraError {
    /** The `ctx.authApi.<method>` that was called without `headers`. */
    public readonly method: string;

    public constructor(method: string) {
        super(
            "AUTH_HEADERS_MISSING",
            `@lunora/auth: ctx.authApi.${method}(…) was called without \`headers\`. ` +
                "better-auth treats a header-less call as a trusted server-to-server " +
                "invocation and skips session authorization entirely — an authorization " +
                "bypass. Pass the inbound request headers: " +
                `ctx.authApi.${method}({ body, headers: request.headers }). ` +
                "If you genuinely intend an unauthenticated server-to-server call, opt " +
                "out explicitly via ctx.authApi.withoutHeaders().<method>(…), or disable " +
                "the guard for the whole middleware with withAuthPlugins(auth, { enforceHeaders: false }).",
            { name: "LunoraAuthHeadersError" },
        );

        this.method = method;
    }
}

/**
 * Options for {@link withAuthPlugins}.
 */
export interface WithAuthPluginsOptions {
    /**
     * Whether to install the runtime header guard around `ctx.authApi`.
     *
     * **Defaults to `true` — the safe default.** When enabled, every
     * `ctx.authApi.<method>(…)` call that omits `headers` throws
     * {@link LunoraAuthHeadersError} instead of silently running with full
     * server-to-server privileges. For a deliberate, per-call unauthenticated
     * invocation, use the explicit `ctx.authApi.withoutHeaders()` escape hatch
     * rather than disabling the guard wholesale.
     *
     * Set to `false` only when you have audited every `ctx.authApi.*` call site
     * and accept responsibility for passing headers yourself. This is the loud,
     * all-or-nothing opt-out; prefer `withoutHeaders()` for one-offs.
     */
    enforceHeaders?: boolean;
}

/**
 * The Lunora context extension this middleware installs. It does *not* replace
 * `ctx.auth` (the identity-only surface populated by the runtime — `userId` and
 * `getIdentity()`); instead it adds a sibling `ctx.authApi` that points at the
 * full better-auth plugin API surface.
 *
 * The shape of `authApi` is the shape of the better-auth instance's `api` —
 * a flat record of endpoint functions like `createOrganization`, `banUser`,
 * `listMembers`, … contributed by whichever plugins are configured on the auth
 * instance. Because the type is `Auth["api"]` and `LunoraAuth` is generic over
 * the auth instance, callers get end-to-end inference: the endpoints they see
 * are exactly the ones their auth instance loaded.
 */
export interface LunoraAuthApiContext<Auth extends LunoraAuth> {
    /**
     * The better-auth endpoint surface — every endpoint contributed by every
     * plugin configured on the auth instance, ready to call directly:
     *
     * ```ts
     * await ctx.authApi.createOrganization({ body: { name: "Acme" }, headers });
     * await ctx.authApi.banUser({ body: { userId: "u_1" }, headers });
     * ```
     *
     * # ⚠️ SECURITY: privileged surface — you MUST pass `headers`
     *
     * This is the **full, privileged** better-auth API (`auth.api`) — it
     * includes admin/management endpoints such as `banUser`, `setRole`,
     * impersonation, `createOrganization`, `removeMember`, … better-auth
     * authorizes these calls from the caller's session in the `headers` you
     * pass. Invoked **without** `headers`, better-auth treats the call as a
     * trusted server-side invocation and **bypasses session authorization
     * entirely** — any procedure that can reach `ctx.authApi` could then ban a
     * user, escalate a role, or read another tenant's data.
     *
     * To stop that bypass at runtime, `withAuthPlugins` installs a guard around
     * `ctx.authApi` by default: a header-less call to any endpoint throws
     * {@link LunoraAuthHeadersError} rather than running with full privileges.
     * The same `auth_api_call_without_headers` advisor lint catches it
     * statically; the guard is the runtime backstop for the cases the lint
     * can't see (dynamic method names, indirected calls). For the rare,
     * deliberate unauthenticated server-to-server call, opt out explicitly with
     * `ctx.authApi.withoutHeaders().<method>(…)`.
     *
     * Lunora's procedure context carries only the resolved identity, not the
     * raw inbound `Headers`, so this middleware CANNOT pre-bind them for you.
     * Therefore: **thread the inbound `Headers` into every `ctx.authApi.*`
     * call** (typically from an HTTP action — see {@link withAuthPlugins}). A
     * header-less call is an authorization bypass, not a convenience.
     */
    readonly authApi: {
        /**
         * Explicit, loud escape hatch from the runtime header guard. Returns
         * the raw, **unguarded** `auth.api` surface — every endpoint reached
         * through it runs as a trusted server-to-server call with session
         * authorization skipped.
         *
         * ```ts
         * // A scheduled job with no inbound request that must create the
         * // system org. Audited and intentional:
         * await ctx.authApi.withoutHeaders().createOrganization({ body: { name } });
         * ```
         *
         * Use only for deliberate, audited unauthenticated calls. For ordinary
         * request-driven calls, pass `headers` so authorization is enforced.
         */
        withoutHeaders: () => Auth["api"];
    } & Auth["api"];
}

/**
 * Build a Lunora middleware that mounts a better-auth instance's plugin API
 * onto `ctx.authApi`. Compose it with `.use(...)` once per builder and every
 * downstream handler gets typed access to the plugin endpoints — no more
 * importing the auth instance directly from every query/mutation file.
 *
 * # ⚠️ SECURITY: headers are load-bearing for authorization
 *
 * `ctx.authApi` is the **full privileged** better-auth surface (`auth.api`):
 * `banUser`, `setRole`, impersonation, `createOrganization`, `removeMember`,
 * and so on. better-auth authorizes these from the caller's session carried in
 * the `headers` you pass. **Called without `headers`, better-auth treats the
 * invocation as a trusted server-side call and skips session authorization
 * altogether** — so a header-less `ctx.authApi.banUser(...)` from any procedure
 * runs with full privileges regardless of who the caller is. This is an
 * authorization bypass, not just a missing convenience.
 *
 * To make that bypass fail loudly instead of silently, this middleware wraps
 * `ctx.authApi` in a **runtime header guard by default**: any endpoint called
 * without a `headers` property throws {@link LunoraAuthHeadersError}. The guard
 * mirrors the static `auth_api_call_without_headers` advisor lint exactly, so
 * the two agree on what counts as a header-bearing call.
 *
 * - **Default (safe):** `withAuthPlugins(auth)` — header-less calls throw.
 * - **Per-call opt-out (preferred):** `ctx.authApi.withoutHeaders().banUser(…)`
 * for a deliberate, audited unauthenticated server-to-server call.
 * - **Whole-middleware opt-out (loud):** `withAuthPlugins(auth, { enforceHeaders: false })`
 * disables the guard entirely; only do this once every call site is audited.
 *
 * Lunora's procedure context does not currently carry the raw request headers
 * (only the resolved identity — see `AuthState` in `@lunora/server`), so
 * this middleware **cannot** pre-bind headers for you and does **not** do so.
 * You MUST pass the inbound `Headers` explicitly into **every** `ctx.authApi.*`
 * call, from a transport that has them — typically an HTTP action:
 *
 * ```ts
 * // lunora/orgs.ts
 * import { httpAction } from "@lunora/server";
 * import { withAuthPlugins } from "@lunora/auth/middleware";
 * import { auth } from "./auth.js";
 *
 * export const createOrg = httpAction(async (ctx, request) => {
 *     const { name } = await request.json();
 *
 *     // ctx.authApi is installed by withAuthPlugins(auth) on the builder.
 *     const org = await ctx.authApi.createOrganization({
 *         body: { name },
 *         headers: request.headers,
 *     });
 *
 *     return Response.json(org);
 * });
 * ```
 *
 * For internal server-to-server calls where there is no inbound request
 * (e.g. a scheduled job that creates the system org), opt out explicitly with
 * `ctx.authApi.withoutHeaders()` and authenticate with whatever bearer token
 * your auth instance is configured to honour.
 */

/**
 * Shape of the middleware {@link withAuthPlugins} returns: a callable generic
 * over the incoming ctx so chaining `.use(...)` preserves whatever ctx fields
 * the upstream middleware already installed. Lives as its own interface
 * because TypeScript doesn't allow declaring `const fn: <CtxIn>() => ...` —
 * the generic must live on a callable type alias or interface.
 */
export type WithAuthPluginsMiddleware<Auth extends LunoraAuth> = <ContextIn>(options: {
    ctx: ContextIn;
    next: MiddlewareNext<ContextIn>;
}) => Promise<ContextIn & LunoraAuthApiContext<Auth>>;

export const withAuthPlugins = <Auth extends LunoraAuth>(auth: Auth, options: WithAuthPluginsOptions = {}): WithAuthPluginsMiddleware<Auth> => {
    const enforceHeaders = options.enforceHeaders ?? true;

    // Build the surface once per middleware, not per request: the guard proxy
    // is stateless, so the same wrapped object is safe to share across calls.
    const authApi = enforceHeaders
        ? (guardAuthApi(auth.api as Record<string, unknown>) as LunoraAuthApiContext<Auth>["authApi"])
        : (auth.api as LunoraAuthApiContext<Auth>["authApi"]);

    // The callable is generic over CtxIn so `next({ ctx: { authApi } })`
    // returns `CtxIn & { authApi }` — fields the upstream middleware
    // installed survive into the downstream chain. Returning the extended ctx
    // (instead of a fresh object) is critical: the structural mirror of
    // `Middleware` says the return value IS the new ctx, so returning anything
    // narrower would drop upstream fields.
    return async <ContextIn>({ next }: { ctx: ContextIn; next: MiddlewareNext<ContextIn> }): Promise<ContextIn & LunoraAuthApiContext<Auth>> => {
        const extended = await next({ ctx: { authApi } });

        return extended;
    };
};
