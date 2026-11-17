/**
 * The `Cache-Control` an `httpRoute(...).cacheControl()` route actually sends.
 *
 * The handler runs under the caller's `ctx.auth`, so a body produced for a
 * credentialed request is presumed caller-specific, and a shared cache must never
 * store it: Cloudflare keys its cache on the URL and ignores `Vary` beyond
 * `Accept-Encoding`, so `public` on such a response hands one user's body to the
 * next visitor. The credential check and the narrowing are the shared ones the
 * REST cache uses (`shared/rest-surface.ts`); what lives here is the route side:
 * reading the hono context and the dev notice.
 */
import { isDevEnvironment } from "@lunora/shard-engine";

import type { ExecutionContextLike } from "../../../shared/execution-context";
import { carriesCredential, CREDENTIAL_HEADERS, privateCacheControl } from "../../../shared/rest-surface";

/** The route a `Cache-Control` is declared on. Held by identity: the dev notice fires once per route object. */
interface CachedRoute {
    /** Extra request headers the app authenticates on, from `.cacheControl(value, { credentialHeaders })`. */
    readonly credentialHeaders?: ReadonlyArray<string>;
    readonly method: string;
    readonly path: string;
}

/** The parts of a hono `Context` this module reads. */
interface RouteExchange {
    readonly env: unknown;
    readonly executionCtx: ExecutionContextLike;
    readonly req: { readonly raw: Request };
}

/** Routes that already logged their dev notice, so each logs it once. */
const warnedRoutes = new WeakSet<CachedRoute>();

/** The request's `ExecutionContext`. hono's `executionCtx` getter throws when the app was fetched without one (a unit test, a sub-handler mount): no Access identity then. */
const executionContextOf = (c: RouteExchange): ExecutionContextLike | undefined => {
    try {
        return c.executionCtx;
    } catch {
        return undefined;
    }
};

/** Which credential the request presented, for the dev notice only. */
const credentialLabel = (headers: Headers, extraHeaders: ReadonlyArray<string>): string =>
    [...CREDENTIAL_HEADERS, ...extraHeaders].find((name) => headers.has(name)) ?? "cloudflare access";

/**
 * The declared `Cache-Control`, or, when the request carries a credential, the
 * value narrowed to `private` (see `privateCacheControl`). In development the
 * first narrowing on each route logs a warning, because the header sent is not
 * the one written.
 */
const routeCacheControl = (route: CachedRoute, declared: string, c: RouteExchange): string => {
    const { headers } = c.req.raw;
    const extraHeaders = route.credentialHeaders ?? [];

    if (!carriesCredential(headers, executionContextOf(c), extraHeaders)) {
        return declared;
    }

    const narrowed = privateCacheControl(declared);

    if (narrowed !== declared && !warnedRoutes.has(route) && isDevEnvironment(c.env)) {
        warnedRoutes.add(route);
        // eslint-disable-next-line no-console -- one dev-only notice per route: the declared header is not what was sent
        console.warn(
            `[lunora] httpRoute ${route.method} ${route.path}: sent Cache-Control "${narrowed}" instead of the declared "${declared}" because the request carries a credential (${credentialLabel(headers, extraHeaders)}). A shared cache must not store a per-caller response. Further downgrades on this route are not reported.`,
        );
    }

    return narrowed;
};

export default routeCacheControl;
