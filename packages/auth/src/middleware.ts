import type { CirrusAuth } from "./create-auth.js";

/**
 * Structural mirror of `@cirrus/server`'s `MiddlewareNext` — the continuation
 * callback handed to a middleware. Repeated here so this package does not take
 * a runtime dependency on `@cirrus/server`; the types are assignable from the
 * fully-typed builder.
 */
interface MiddlewareNext<CtxIn> {
    (): Promise<CtxIn>;
    <Extension extends Record<string, unknown>>(options: { ctx: Extension }): Promise<CtxIn & Extension>;
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
     */
    readonly authApi: Auth["api"];
}

/**
 * Build a Cirrus middleware that mounts a better-auth instance's plugin API
 * onto `ctx.authApi`. Compose it with `.use(...)` once per builder and every
 * downstream handler gets typed access to the plugin endpoints — no more
 * importing the auth instance directly from every query/mutation file.
 *
 * # Headers caveat
 *
 * better-auth's `auth.api.<endpoint>({ headers, body })` calls almost always
 * need the inbound `Headers` so the endpoint can resolve the caller's session,
 * verify CSRF, enforce origin checks, etc. Cirrus's procedure context does
 * not currently carry the raw request headers (only the resolved identity —
 * see {@link AuthState} in `@cirrus/server`), so the middleware does **not**
 * pre-bind headers for you. Pass them explicitly from a transport that has
 * them, typically an HTTP action:
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
 * because TypeScript doesn't allow declaring `const fn: <CtxIn>() => ...` —
 * the generic must live on a callable type alias or interface.
 */
export type WithAuthPluginsMiddleware<Auth extends CirrusAuth> = <CtxIn>(options: { ctx: CtxIn; next: MiddlewareNext<CtxIn> }) => Promise<CirrusAuthApiContext<Auth> & CtxIn>;

export const withAuthPlugins = <Auth extends CirrusAuth>(auth: Auth): WithAuthPluginsMiddleware<Auth> => {
    // The callable is generic over CtxIn so `next({ ctx: { authApi } })`
    // returns `CtxIn & { authApi: Auth["api"] }` — fields the upstream
    // middleware installed survive into the downstream chain. Returning the
    // extended ctx (instead of a fresh object) is critical: the structural
    // mirror of `Middleware` says the return value IS the new ctx, so
    // returning anything narrower would drop upstream fields.
    return async <CtxIn>({ next }: { ctx: CtxIn; next: MiddlewareNext<CtxIn> }): Promise<CirrusAuthApiContext<Auth> & CtxIn> => {
        const extended = await next({ ctx: { authApi: auth.api } });

        return extended as CirrusAuthApiContext<Auth> & CtxIn;
    };
};
