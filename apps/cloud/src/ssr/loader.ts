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
 * Session-gate a route: resolve the user or bounce to `/login`, carrying the
 * attempted path so sign-in can return there. Called from `beforeLoad`, so on the
 * initial request the gate is enforced before the first byte rather than as a
 * post-hydration flash.
 */
export const requireSession = async (pathname: string): Promise<StudioSession> => {
    const session = await loadSession();

    if (!session) {
        throw redirect({ search: pathname === "/" ? undefined : { redirect: pathname }, to: "/login" });
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
 */
const preloadOnServer = createServerFn({ method: "GET" })
    .validator((input: { args: Record<string, unknown>; functionPath: string }) => input)
    .handler(async ({ data }): Promise<string> => {
        const { createServerClient, preloadQuery } = await import("@lunora/client/ssr");
        const { getRequest, getRequestUrl } = await import("@tanstack/react-start/server");

        const cookie = getRequest().headers.get("cookie") ?? "";
        const client = createServerClient({
            // Forward the caller's cookies so the RPC runs as the signed-in user.
            fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
                const headers = new Headers(init?.headers);

                if (cookie !== "") {
                    headers.set("cookie", cookie);
                }

                return fetch(input, { ...init, headers });
            },
            url: getRequestUrl().origin,
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
