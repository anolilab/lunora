/**
 * Identity-resolver layer — the generic, scheme-agnostic vocabulary for turning
 * an inbound request into a {@link ResolvedIdentity}, composing several such
 * verifiers, and validating their output against a declared claim contract at
 * the worker's trust boundary.
 *
 * `ResolvedIdentity` and the contract-gate wiring (`wrapResolverWithContract`)
 * were moved here from `create-worker.ts` (which re-exports the public names) so
 * the cohesive identity concern lives in its own module, mirroring the sibling
 * `*-admin-routes.ts` extraction pattern; `composeIdentityResolvers`/`routeIdentityResolvers` are
 * new in this module. Everything here is dependency-free of `createWorker`
 * internals; `IdentityContractLike` is a deliberate structural projection of
 * `@lunora/server`'s `IdentityContract` so `@lunora/runtime` stays free of an
 * `@lunora/server` dependency.
 *
 * Note: `@lunora/cloudflare-access` exports a similarly-purposed `composeResolvers`,
 * but it is a *variadic* first-match-wins helper for its own resolvers (returns the
 * anonymous sentinel, no options). These `*IdentityResolvers` combinators take a
 * resolver array plus error-mode options and are fail-closed — intentionally
 * separate primitives with distinct names to avoid confusing the two.
 */

import { LunoraError } from "./errors";

/**
 * Identity resolved from the inbound request by `WorkerOptions.resolveIdentity`.
 *
 * The `userId` field is special — it becomes `ctx.auth.userId` inside the
 * Durable Object. Any other keys (`email`, `name`, custom roles, etc.) are
 * forwarded verbatim as `ctx.auth.getIdentity()`'s return value.
 *
 * Return `null` to signal that the request is anonymous; the runtime will
 * skip both `x-lunora-userid` and `x-lunora-identity` headers, and
 * `ctx.auth.userId` will be `undefined` on the shard side.
 */
interface ResolvedIdentity {
    /** Arbitrary additional claims. Must be JSON-serialisable. */
    [key: string]: unknown;

    /**
     * JWT-standard expiry in epoch SECONDS. When present (and `expiresAtMs` is
     * absent), the runtime forwards it as the socket's credential expiry — the
     * DO drops the socket once it lapses. Used only on the WebSocket path.
     */
    exp?: number;

    /**
     * Credential expiry in epoch MILLISECONDS. Preferred over `exp` when
     * both are present. Forwarded as the socket's expiry on the WebSocket path
     * so the DO drops the socket once it lapses; omit for non-expiring sessions.
     */
    expiresAtMs?: number;

    /** Stable user identifier (e.g. `"user_2k3..."` or `"u_42"`). */
    userId: string;
}

/**
 * A verifier that turns an inbound request into a {@link ResolvedIdentity} (or
 * `null` for anonymous). Structurally identical to `WorkerOptions.resolveIdentity`,
 * so `.auth()`'s better-auth session resolver, a signed-preview-link verifier, a
 * per-tenant bearer check, an upstream-JWT reader, … are all just `IdentityResolver`s
 * — the identity layer is generic over every scheme, not coupled to any one.
 */
type IdentityResolver = (request: Request, env: unknown) => Promise<ResolvedIdentity | null> | ResolvedIdentity | null;

/** Error policy for {@link composeIdentityResolvers} when a participant resolver throws. */
type ComposeIdentityResolversErrorMode = "fail-closed" | "skip";

/** Options for {@link composeIdentityResolvers}. */
interface ComposeIdentityResolversOptions {
    /**
     * What to do when a resolver throws. `"fail-closed"` (default, safe)
     * re-throws so a broken verifier fails the request rather than silently
     * falling through to a weaker one; `"skip"` swallows the error and tries the
     * next resolver (use only when a resolver's failure genuinely means "not my
     * scheme").
     */
    readonly onError?: ComposeIdentityResolversErrorMode;
}

/**
 * Compose several {@link IdentityResolver}s into one, first-match-wins: each is
 * tried in order and the first that returns a non-null identity short-circuits.
 * Generic over every scheme — the better-auth session resolver (obtained via the
 * builder's `derived.resolveIdentity` escape hatch) is just one entry in the list,
 * so composition never means losing it.
 *
 * A resolver that throws is handled per {@link ComposeIdentityResolversOptions.onError}
 * (default `"fail-closed"`: the error propagates).
 */
const composeIdentityResolvers = (resolvers: ReadonlyArray<IdentityResolver>, options: ComposeIdentityResolversOptions = {}): IdentityResolver => {
    const onError: ComposeIdentityResolversErrorMode = options.onError ?? "fail-closed";

    return async (request: Request, env: unknown): Promise<ResolvedIdentity | null> => {
        for (const resolver of resolvers) {
            let resolved: ResolvedIdentity | null;

            try {
                // eslint-disable-next-line no-await-in-loop -- ordered first-match-wins: a later resolver must not run until the earlier one has settled (and short-circuit on the first hit)
                resolved = await resolver(request, env);
            } catch (error: unknown) {
                if (onError === "skip") {
                    continue;
                }

                throw error;
            }

            if (resolved) {
                return resolved;
            }
        }

        // eslint-disable-next-line unicorn/no-null -- `null` is the resolver contract's anonymous sentinel (matches WorkerOptions.resolveIdentity)
        return null;
    };
};

/**
 * A thin, generic helper over {@link composeIdentityResolvers} for the per-route case:
 * pick a resolver by `new URL(request.url).pathname`. Keys are matched by longest
 * path prefix; `"*"` is the fallback. Still fully generic — a route→resolver map,
 * with no portal / preview / tenant concepts baked in (those live in the app's
 * own resolvers).
 * @example
 * routeIdentityResolvers({ "/admin": adminResolver, "/partner": partnerResolver, "*": sessionResolver })
 */
const routeIdentityResolvers = (routes: Record<string, IdentityResolver>): IdentityResolver => {
    // Longest-prefix first so `/admin/x` prefers `/admin` over a shorter match;
    // `"*"` is excluded here and only used as the explicit fallback below.
    const prefixes = Object.keys(routes)
        .filter((key) => key !== "*")
        .toSorted((a, b) => b.length - a.length);

    return (request: Request, env: unknown): Promise<ResolvedIdentity | null> | ResolvedIdentity | null => {
        const { pathname } = new URL(request.url);
        const matched = prefixes.find((prefix) => pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`));
        const resolver = matched === undefined ? routes["*"] : routes[matched];

        if (resolver === undefined) {
            // eslint-disable-next-line unicorn/no-null -- anonymous sentinel: no route matched and no `"*"` fallback declared
            return null;
        }

        return resolver(request, env);
    };
};

/** The result of validating a candidate identity against an {@link IdentityContractLike}. */
type IdentityValidation = { ok: true } | { error: string; ok: false };

/**
 * Structural view of `@lunora/server`'s `IdentityContract` (from `defineIdentity`).
 * Kept structural so `@lunora/runtime` stays free of an `@lunora/server` dependency.
 * Keep the `onInvalid` union and `validate`/`IdentityValidation` shapes in sync with
 * `@lunora/server`'s `IdentityContract` — they are projected by hand, not imported.
 * The generated worker entry passes the app's `defineIdentity(...)` result here;
 * the worker validates every resolver's returned claims against it at the trust
 * boundary before they become `ctx.auth`.
 */
interface IdentityContractLike {
    /** Reject policy applied when validation fails: downgrade to anonymous, or reject the request (401). */
    readonly onInvalid: "anonymous" | "reject";
    /** Validate resolver-returned claims against the declared contract. */
    validate: (identity: Record<string, unknown>) => IdentityValidation;
}

/**
 * The trust-boundary identity gate. Given the worker's `resolveIdentity` and an
 * optional `defineIdentity(...)` contract, return a resolver that validates every
 * resolved identity against the declared claims BEFORE it becomes `ctx.auth`.
 *
 * Claims arrive from untrusted tokens; a forged / malformed set is either
 * downgraded to anonymous (`onInvalid: "anonymous"`, the safe default — the bad
 * identity never reaches a policy as valid) or rejected with a `401`
 * (`onInvalid: "reject"`), rather than flowing in as an unchecked cast. A valid
 * identity is returned unchanged, so undeclared claims are forwarded verbatim.
 *
 * When no contract is configured (or there is no `resolveIdentity`), the original
 * resolver is returned untouched — zero overhead and byte-identical behaviour.
 * Only the public data paths (RPC / WebSocket / HTTP-action / server-query) use
 * the wrapped resolver; the admin path keeps the raw one (admin is gated by the
 * bearer / Access, not the app's identity contract).
 */
const wrapResolverWithContract = (
    baseResolveIdentity: IdentityResolver | undefined,
    contract: IdentityContractLike | undefined,
): IdentityResolver | undefined => {
    if (contract === undefined || baseResolveIdentity === undefined) {
        return baseResolveIdentity;
    }

    return async (request: Request, env: unknown): Promise<ResolvedIdentity | null> => {
        const resolved = await baseResolveIdentity(request, env);

        if (!resolved) {
            return resolved;
        }

        const result = contract.validate(resolved);

        if (result.ok) {
            return resolved;
        }

        if (contract.onInvalid === "reject") {
            throw new LunoraError(`identity claims failed the declared contract: ${result.error}`, { code: "UNAUTHENTICATED", status: 401 });
        }

        // eslint-disable-next-line unicorn/no-null -- downgrade a contract-violating identity to the anonymous sentinel
        return null;
    };
};

export type {
    ComposeIdentityResolversErrorMode,
    ComposeIdentityResolversOptions,
    IdentityContractLike,
    IdentityResolver,
    IdentityValidation,
    ResolvedIdentity,
};
export { composeIdentityResolvers, routeIdentityResolvers, wrapResolverWithContract };
