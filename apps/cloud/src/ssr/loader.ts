import type { ArgsOf, FunctionReference, Preloaded, ReturnOf } from "@lunora/client/ssr";
import { redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

/**
 * Server-side data loading for the hosted studio's routes.
 *
 * Everything here runs through `createServerFn`, which is what makes it correct on
 * both sides of a navigation. A TanStack `loader` executes on the **server** for
 * the initial SSR render and on the **client** for every navigation after it, so a
 * loader helper cannot simply reach for request-scoped server APIs — the client
 * bundle has no `getRequest()`, and the build's import-protection rejects the
 * attempt outright. A server function is callable from either side: invoked during
 * SSR it runs in-process, invoked from the browser it RPCs to the server.
 *
 * The two seams both go through the control-plane Worker's own HTTP surface rather
 * than reaching for `env`:
 *
 * - **Session** — `GET /api/auth/get-session` with the inbound cookies. The Worker
 *   dispatches `/api/auth/*` itself, ahead of the SSR `httpRouter`, so this is an
 *   ordinary subrequest that cannot recurse into the renderer.
 * - **Data** — `@lunora/client/ssr`'s request-scoped client, speaking the same
 *   `POST /_lunora/rpc` envelope the browser uses. Also dispatched ahead of
 *   `httpRouter`, so it likewise cannot loop.
 *
 * Identity is carried by forwarding the inbound `cookie` header exactly as the
 * browser would: `resolveIdentity` in `src/server.ts` reads the better-auth session
 * off those cookies, so a server-side load runs as the signed-in user under the
 * same RLS and shard-authorization gates as the client's own queries.
 *
 * The runtime also offers an in-process fast path, `worker.serverQuery(request,
 * env, …)`, which trades a subrequest for a direct shard dispatch with documented
 * identity parity. It needs both the worker instance and `env` threaded into the
 * render, which a server function does not have — so it stays a future
 * optimisation, not the mechanism here.
 */

/** The signed-in user as `/api/auth/get-session` reports it. */
export interface StudioSession {
    session: { id: string };
    user: { email: string; id: string; name?: string };
}

/**
 * Resolve the signed-in user, or `null` for an anonymous visitor. Never throws — a
 * failed session lookup is treated as "not signed in", so a transient auth outage
 * renders the login screen rather than a 500.
 */
export const loadSession = createServerFn({ method: "GET" }).handler(async (): Promise<StudioSession | null> => {
    // Imported inside the handler: `@tanstack/react-start/server` is server-only,
    // and a top-level import would be pulled into the client bundle by any route
    // that imports this module.
    const { getRequest, getRequestUrl } = await import("@tanstack/react-start/server");
    const cookie = getRequest().headers.get("cookie") ?? "";

    if (cookie === "") {
        return null;
    }

    try {
        const response = await fetch(new URL("/api/auth/get-session", getRequestUrl().origin), {
            headers: { accept: "application/json", cookie },
        });

        if (!response.ok) {
            return null;
        }

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- `json()` resolves to `any`; the assertion is what documents (and type-checks) the shape null-checked below
        const body = (await response.json()) as StudioSession | null;

        return body?.user?.id === undefined ? null : body;
    } catch {
        return null;
    }
});

/**
 * The organization ids the signed-in caller is actually a member of.
 *
 * Used to gate `/orgs/$organizationId` before its tabs load. Every tab query runs
 * `assertMember`, so a URL naming an org the caller does not belong to — a stale
 * bookmark, a deep link from a wiped dev database, someone else's id — makes the
 * FIRST tab query throw `FORBIDDEN: not a member of this organization` and drops
 * the visitor on an error boundary with no way back. Resolving membership up front
 * lets the route bounce them home instead.
 *
 * Reads `organizations:list`, which is already membership-scoped server-side, so
 * this leaks nothing the caller could not fetch itself.
 */
export const loadMyOrganizationIds = createServerFn({ method: "GET" }).handler(async (): Promise<string[]> => {
    const { createServerClient } = await import("@lunora/client/ssr");
    const { getRequest, getRequestUrl } = await import("@tanstack/react-start/server");
    const { api } = await import("../../lunora/_generated/api.js");

    const cookie = getRequest().headers.get("cookie") ?? "";
    const { origin } = getRequestUrl();
    const client = createServerClient({
        fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            const headers = new Headers(init?.headers);

            if (cookie !== "") {
                headers.set("cookie", cookie);
            }

            // Same reason as `preloadOnServer`: `enforceOrigin` rejects a cookie-bearing
            // unsafe-method request that names no origin.
            headers.set("origin", origin);

            return fetch(input, { ...init, headers });
        },
        url: origin,
    });

    try {
        const organizations = await client.query(api.organizations.list, {});

        return organizations.map((organization) => organization._id);
    } catch {
        // An unauthenticated or failed lookup resolves to "no memberships"; the
        // session gate in `_authed` has already handled the anonymous case.
        return [];
    }
});

/**
 * Session-gate a route: resolve the user or bounce to `/login`, carrying the whole
 * attempted location (path *and* search) so sign-in can return them to the exact
 * deep link. Called from `beforeLoad`, so on the initial request the gate is
 * enforced before the first byte rather than as a post-hydration flash.
 */
export const requireSession = async (target: string): Promise<StudioSession> => {
    const session = await loadSession();

    if (!session) {
        // `target` is the full `pathname + search` the visitor asked for, so a deep
        // link survives the round trip through sign-in. `/login` re-validates it to a
        // same-origin path before using it, so passing it through here is safe.
        throw redirect({ search: target === "/" ? undefined : { redirect: target }, to: "/login" });
    }

    return session;
};

/**
 * Run one Lunora query on the server and return the serializable token
 * `usePreloadedQuery` hydrates from.
 *
 * A `FunctionReference` is just `{ __lunoraRef: "path" }`, so only the path and
 * args cross the server-function boundary — which is what lets the same call work
 * from an SSR render and from a client navigation.
 *
 * SECURITY — the `functionPath` is caller-supplied, and a server function is a
 * publicly reachable endpoint, so this is a generic "run a Lunora function as me"
 * proxy unless it is constrained. Two things constrain it:
 *
 * 1. **`kind` is checked against the generated registry.** The `/_lunora/rpc`
 *    envelope carries only `{ args, functionPath, shardKey }` — no operation kind —
 *    so the RPC layer cannot tell a query call from a mutation call and would
 *    happily execute `organizations:requestDeletion` if that path were passed to
 *    `preloadQuery`. Rejecting anything whose registered `kind` is not `"query"`
 *    is what stops this from being a confused-deputy that mutates on read.
 * 2. **`POST`, not `GET`.** A `GET` server function is reachable cross-site by a
 *    bare `&lt;img>`/navigation carrying the victim's cookies; a state-changing
 *    confused deputy behind `GET` is trivially CSRF-able. Preloading is logically
 *    a read, but the transport must not be the thing standing between an attacker
 *    and a write. `createCsrfMiddleware` in `src/start.ts` enforces same-origin on
 *    top of this.
 *
 * Note this grants no privilege the browser lacks — it forwards the caller's own
 * cookies, so RLS and the shard-authorization gate apply exactly as they do to a
 * direct `/_lunora/rpc` call. The gate is about not widening the *verb*.
 */
const preloadOnServer = createServerFn({ method: "POST" })
    .validator((input: { args: Record<string, unknown>; functionPath: string }) => input)
    .handler(async ({ data }): Promise<string> => {
        const { createServerClient, preloadQuery } = await import("@lunora/client/ssr");
        const { getRequest, getRequestUrl } = await import("@tanstack/react-start/server");
        const { LUNORA_FUNCTIONS } = await import("../../lunora/_generated/functions.js");

        const registered = LUNORA_FUNCTIONS[data.functionPath];

        if (registered?.kind !== "query") {
            throw new Error(`preload: "${data.functionPath}" is not a query`);
        }

        const cookie = getRequest().headers.get("cookie") ?? "";
        const { origin } = getRequestUrl();
        const client = createServerClient({
            fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
                const headers = new Headers(init?.headers);

                // Forward the caller's cookies so the RPC runs as the signed-in user.
                if (cookie !== "") {
                    headers.set("cookie", cookie);
                }

                // And declare the origin, which is genuinely this worker's own.
                //
                // Without it every preload is rejected 403 before routing. The
                // runtime's `enforceOrigin` guard (CSRF, on by default) blocks any
                // unsafe-method request that carries a cookie but names no
                // `Origin`/`Referer` — and `LunoraClient` sends only
                // `content-type` on its `POST /_lunora/rpc`. So a cookie-forwarded
                // preload trips the guard on every route loader: the loaders throw,
                // and every authenticated page renders the error boundary while
                // `/login` (a GET, hence CSRF-exempt) still works. That asymmetry is
                // why a smoke test of `/` alone does not catch it.
                //
                // Safe to assert only because `functionPath` is now gated to
                // registered queries above — the guard is no longer the thing
                // standing between a caller and an arbitrary mutation.
                headers.set("origin", origin);

                return fetch(input, { ...init, headers });
            },
            url: origin,
        });

        // Serialized rather than returned as an object: a server function's return
        // type must be *provably* serializable, and `Preloaded<T>` carries
        // `args: Record<string, unknown>` — `unknown` fails that proof even though
        // every value in it is JSON by construction (the token was built from an
        // HTTP RPC response). One JSON round trip keeps the contract honest.
        return JSON.stringify(await preloadQuery(client, { __lunoraRef: data.functionPath }, data.args));
    });

/** Typed wrapper over {@link preloadOnServer} — takes the generated `api` reference directly. */
export const preload = async <F extends FunctionReference>(reference: F, args: ArgsOf<F>): Promise<Preloaded<ReturnOf<F>>> => {
    const serialized = await preloadOnServer({
        data: { args: args ?? {}, functionPath: reference.__lunoraRef },
    });

    return JSON.parse(serialized) as Preloaded<ReturnOf<F>>;
};
