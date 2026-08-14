/**
 * The subset of the Cloudflare `ExecutionContext` the Lunora worker entry and
 * the framework mount seams rely on — `waitUntil` for fire-and-forget work that
 * must outlive the response, and `passThroughOnException` for the top-level
 * error posture.
 *
 * It is deliberately **not** a package. `@lunora/runtime` is the leaf server
 * runtime and `@lunora/nuxt` is a framework integration that intentionally does
 * not depend on `@lunora/runtime`'s worker types, yet both need this exact
 * shape: the runtime to build/forward the worker `fetch`, Nuxt to forward an
 * inbound request to the user's composed worker. Each imports this file by
 * relative path and the bundler (packem/rollup) inlines it: no runtime
 * dependency edge is created, the helper is duplicated only in emitted output,
 * never in source. One source of truth, zero deps. See AGENTS.md → "Top-level
 * `shared/` — bundler-inlined source".
 *
 * Both methods are **optional**: a real Cloudflare `ExecutionContext` always
 * supplies them, but a host that mounts Lunora as a sub-handler (Nitro/H3, a
 * non-Cloudflare preview, a unit test) may hand over a partial context or none
 * at all. Callers therefore invoke them defensively (`ctx.waitUntil?.(…)`) or
 * fall back to {@link NOOP_EXECUTION_CONTEXT}.
 */
export interface ExecutionContextLike {
    /**
     * Present only when Cloudflare Access authenticated the request against a
     * policy attached to the **Worker** (rather than to a hostname). `undefined`
     * on every unauthenticated request, so its presence is itself the "Access
     * authorized this caller" signal — see {@link AccessContextLike}.
     */
    access?: AccessContextLike;
    cache?: {
        purge: (options: { purgeEverything?: boolean; tags?: string[] }) => Promise<unknown>;
    };
    passThroughOnException?: () => void;
    waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * The identity Cloudflare Access attaches to a Worker-protected request.
 *
 * Shape follows the Access application-token payload: `sub` is the stable per-user
 * id, `email` the verified address, `common_name` the service-token name (machine
 * callers, whose `sub` is empty), and `exp` the credential expiry in epoch
 * **seconds**. Group membership is whatever the Access policy emits — a list of
 * names, or of `{ id, name }` objects — hence `unknown`; normalize before use.
 *
 * Cloudflare may add further fields, so the index signature keeps them rather
 * than dropping them: this is a view of a payload we do not own.
 */
export interface AccessIdentityLike {
    [claim: string]: unknown;
    /** Service-token name. Present for non-interactive (machine) callers instead of `email`. */
    common_name?: string;
    /** Verified user email. Present for interactive (SSO) callers. */
    email?: string;
    /** Credential expiry, epoch **seconds**. */
    exp?: number;
    /** IdP group membership — names or `{ id, name }` objects, depending on the policy. */
    groups?: unknown;
    /** Display name from the identity provider, when it emits one. */
    name?: string;
    /** Stable per-user id, and what consumers key a user on. Empty for service tokens. */
    sub?: string;
    /** Cloudflare's per-user UUID. Carried through, but deliberately not used as an id — only this path emits it, so keying on it would not match the JWT path. */
    user_uuid?: string;
}

/**
 * The `ctx.access` facade Cloudflare exposes on a Worker protected by Access.
 *
 * Reading the identity from here is preferable to verifying the
 * `Cf-Access-Jwt-Assertion` header: the platform has already authenticated the
 * caller, so there is no JWKS fetch, no audience check to get wrong, and nothing
 * a request can forge — the field simply does not exist unless Access authorized
 * the call. The header path remains the fallback for hostname-scoped Access
 * applications, which do not populate this.
 */
export interface AccessContextLike {
    getIdentity: () => AccessIdentityLike | null | undefined | Promise<AccessIdentityLike | null | undefined>;
}

/**
 * No-op `ExecutionContext` used when the host runtime didn't supply one (a
 * non-Cloudflare preview, or a unit test), so the worker's `fetch` always
 * receives a valid third argument.
 */
export const NOOP_EXECUTION_CONTEXT: ExecutionContextLike = {
    passThroughOnException: () => {},
    waitUntil: () => {},
};
