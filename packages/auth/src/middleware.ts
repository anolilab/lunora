import type { CirrusAuth } from "./create-auth.js";

/**
 * Structural mirror of `@cirrus/server`'s `MiddlewareNext` — the continuation
 * callback handed to a middleware. Repeated here so this package does not take
 * a runtime dependency on `@cirrus/server`; the types are assignable from the
 * fully-typed builder.
 */
interface MiddlewareNext<ContextIn> {
    (): Promise<ContextIn>;
    <Extension extends Record<string, unknown>>(options: { ctx: Extension }): Promise<ContextIn & Extension>;
}

/**
 * The Cirrus context extension this middleware installs. It does *not* replace
 * `ctx.auth` (the identity-only surface populated by the runtime — `userId` and
 * `getIdentity()`); instead it adds a sibling `ctx.authApi` that points at the
 * full better-auth plugin API surface.
 *
 * The shape of `authApi` is the shape of the better-auth instance's `api` —
 * a flat record of endpoint functions like `createOrganization`, `banUser`,
 * `listMembers`, … contributed by whichever plugins are configured on the auth
 * instance. Because the type is `Auth["api"]` and `CirrusAuth` is generic over
 * the auth instance, callers get end-to-end inference: the endpoints they see
 * are exactly the ones their auth instance loaded.
 */
export interface CirrusAuthApiContext<Auth extends CirrusAuth> {
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
     * Cirrus's procedure context carries only the resolved identity, not the
     * raw inbound `Headers`, so this middleware CANNOT pre-bind them for you.
     * Therefore: **thread the inbound `Headers` into every `ctx.authApi.*`
     * call** (typically from an HTTP action — see {@link withAuthPlugins}). A
     * header-less call is an authorization bypass, not a convenience.
     */
    readonly authApi: Auth["api"];
}

/**
 * Build a Cirrus middleware that mounts a better-auth instance's plugin API
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
 * Cirrus's procedure context does not currently carry the raw request headers
 * (only the resolved identity — see `AuthState` in `@cirrus/server`), so
 * this middleware **cannot** pre-bind headers for you and does **not** do so.
 * You MUST pass the inbound `Headers` explicitly into **every** `ctx.authApi.*`
 * call, from a transport that has them — typically an HTTP action:
 *
 * ```ts
 * // cirrus/orgs.ts
 * import { httpAction } from "@cirrus/server";
 * import { withAuthPlugins } from "@cirrus/auth/middleware";
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
 * (e.g. a scheduled job that creates the system org), pass an empty
 * `Headers` and authenticate with whatever bearer token your auth instance
 * is configured to honour.
 */

/**
 * Shape of the middleware {@link withAuthPlugins} returns: a callable generic
 * over the incoming ctx so chaining `.use(...)` preserves whatever ctx fields
 * the upstream middleware already installed. Lives as its own interface
 * because TypeScript doesn't allow declaring `const fn: &lt;CtxIn>() => ...` —
 * the generic must live on a callable type alias or interface.
 */
export type WithAuthPluginsMiddleware<Auth extends CirrusAuth> = <ContextIn>(options: {
    ctx: ContextIn;
    next: MiddlewareNext<ContextIn>;
}) => Promise<CirrusAuthApiContext<Auth> & ContextIn>;

export const withAuthPlugins
    = <Auth extends CirrusAuth>(auth: Auth): WithAuthPluginsMiddleware<Auth> =>
    // The callable is generic over CtxIn so `next({ ctx: { authApi } })`
    // returns `CtxIn & { authApi: Auth["api"] }` — fields the upstream
    // middleware installed survive into the downstream chain. Returning the
    // extended ctx (instead of a fresh object) is critical: the structural
    // mirror of `Middleware` says the return value IS the new ctx, so
    // returning anything narrower would drop upstream fields.
        async <ContextIn>({ next }: { ctx: ContextIn; next: MiddlewareNext<ContextIn> }): Promise<CirrusAuthApiContext<Auth> & ContextIn> => {
            const extended = await next({ ctx: { authApi: auth.api } });

            return extended;
        };
