import { createCsrfMiddleware, createStart } from "@tanstack/react-start";

/** Methods that cannot change state, so they need no origin check. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * TanStack Start instance for the hosted studio.
 *
 * Its only job today is CSRF protection for **state-changing server-function
 * calls**. Server functions are publicly reachable endpoints that run with the
 * caller's cookies, so without an origin check a cross-site page could invoke one
 * on a signed-in visitor's behalf.
 *
 * The `filter` is load-bearing, not a refinement. `createCsrfMiddleware` is a
 * request-level middleware, so unfiltered it validates every request the Worker
 * serves — including ordinary page navigations. A top-level browser navigation
 * sends `Sec-Fetch-Site: none` (not `same-origin`), and a cold `curl` sends no
 * origin headers at all, both of which the default policy rejects: the whole
 * studio answers 403 and nothing renders. Restricting it to `serverFn` requests
 * with an unsafe method keeps navigations untouched while still covering the
 * endpoints that can act on the user's behalf.
 *
 * Defence in depth, not the primary control: `src/ssr/loader.ts` independently
 * refuses any function path whose registered kind is not `"query"`, so the preload
 * seam cannot be turned into a write regardless of where the request came from.
 */
export const startInstance = createStart(() => {
    return {
        requestMiddleware: [
            createCsrfMiddleware({
                filter: ({ handlerType, request }) => handlerType === "serverFn" && !SAFE_METHODS.has(request.method.toUpperCase()),
            }),
        ],
    };
});
