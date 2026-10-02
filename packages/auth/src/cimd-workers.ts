/**
 * The Cloudflare Workers transport for `cimd()` (Client ID Metadata Documents).
 *
 * `@better-auth/cimd` fetches a URL the client hands it — the `client_id` itself,
 * and any `jwks_uri` the document names — so the fetch is server-side request
 * forgery waiting to happen unless the transport keeps it on the public internet.
 * The plugin therefore makes the application supply that transport, and asks it to
 * resolve the host once, reject special-use addresses, pin the connection and
 * refuse redirects.
 *
 * A Worker cannot pin a connection or see the resolved address. What it can do is
 * run with the global_fetch_strictly_public compatibility flag, under which every
 * global `fetch` goes out to the public internet and never to a private or
 * special-use address, the Worker's own zone included. That is the guarantee
 * Cloudflare's own `@cloudflare/workers-oauth-provider` builds its CIMD support on,
 * and the one this transport requires: {@link workersCimdFetch} refuses to build
 * without the flag, so a misconfigured deploy fails at startup instead of quietly
 * fetching attacker-chosen internal URLs.
 *
 * It is weaker than the letter of cimd's contract — there is no DNS pinning, so a
 * rebinding host still reaches *some* public address. Pair it with an origin
 * allowlist (the isMetadataDocumentUrlAllowed option) in production.
 *
 * On Node, use `fetchClientMetadataResource` from `@better-auth/cimd/node`, which
 * does pin the connection.
 *
 * Kept off the package root (and out of `./plugins`) because it is Workers-only:
 * the flag probe means nothing on any other runtime.
 */
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";
import { LunoraError } from "@lunora/errors";

/** The compatibility flag this transport depends on. */
const STRICTLY_PUBLIC_FLAG = "global_fetch_strictly_public";

/** The `Cloudflare` global workerd exposes, narrowed to the one field read here. */
interface CloudflareGlobal {
    readonly compatibilityFlags?: Readonly<Record<string, boolean | undefined>>;
}

/**
 * Whether the running Worker has `global_fetch_strictly_public` on. Read from the
 * compatibilityFlags object on the Cloudflare global that workerd exposes — the same probe
 * `workers-oauth-provider` uses. Absent global (any other runtime) reads as off.
 */
const hasStrictlyPublicFetch = (): boolean => {
    const { Cloudflare: cloudflare } = globalThis as { Cloudflare?: CloudflareGlobal };

    return cloudflare?.compatibilityFlags?.[STRICTLY_PUBLIC_FLAG] === true;
};

/** A 3xx, or the opaque stand-in a `redirect: "manual"` fetch can return for one. */
const isRedirect = (response: Response): boolean => (response.status >= 300 && response.status < 400) || response.type === "opaqueredirect";

/**
 * Build the `fetchClientMetadataResource` transport for `cimd()` on Cloudflare
 * Workers.
 *
 * ```ts
 * import { cimd, jwt, mcp } from "@lunora/auth/plugins";
 * import workersCimdFetch from "@lunora/auth/cimd/workers";
 *
 * plugins: [
 *     jwt(),
 *     mcp({ … }),
 *     cimd({
 *         fetchClientMetadataResource: workersCimdFetch(),
 *         metadataProfile: "mcp-2026-07-28",
 *         isMetadataDocumentUrlAllowed: (url) => new URL(url).origin === "https://claude.ai",
 *     }),
 * ];
 * ```
 *
 * The returned transport only issues `GET` / `HEAD` to `https:` URLs without
 * credentials, and never follows a redirect: it fetches with `redirect: "manual"`
 * (workerd does not implement `"error"`) and throws on any 3xx, which cimd reports
 * as `invalid_client`.
 * @throws LunoraError `AUTH_CIMD_FETCH_NOT_PUBLIC` when the Worker runs without the
 * `global_fetch_strictly_public` compatibility flag.
 */
const workersCimdFetch = (): ClientMetadataResourceFetch => {
    if (!hasStrictlyPublicFetch()) {
        throw new LunoraError(
            "AUTH_CIMD_FETCH_NOT_PUBLIC",
            `CIMD needs the "${STRICTLY_PUBLIC_FLAG}" compatibility flag, so metadata fetches cannot reach private addresses. Add it to "compatibility_flags" in wrangler.jsonc.`,
        );
    }

    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        // `redirect` is replaced, not passed through: cimd asks for "error", which the
        // workerd `Request` constructor rejects outright.
        const request = new Request(input, { ...init, redirect: "manual" });
        const url = new URL(request.url);

        if (url.protocol !== "https:") {
            throw new TypeError(`refusing to fetch a client metadata resource over ${url.protocol}`);
        }

        if (url.username !== "" || url.password !== "") {
            throw new TypeError("refusing to fetch a client metadata resource URL that carries credentials");
        }

        if (request.method !== "GET" && request.method !== "HEAD") {
            throw new TypeError(`refusing to ${request.method} a client metadata resource`);
        }

        const response = await fetch(request);

        if (isRedirect(response)) {
            throw new TypeError("client metadata resource fetches must not follow redirects");
        }

        return response;
    };
};

export default workersCimdFetch;
