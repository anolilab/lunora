import type { BetterAuthOptions } from "better-auth";
import { betterAuth } from "better-auth";

/**
 * Cirrus's options pass straight through to better-auth — the only thing we
 * provide is the convention that `database` defaults to `env.DB` (a Cloudflare
 * D1 binding) and `secret` is required so we surface a clear error if it's
 * missing instead of letting better-auth's runtime check fire later.
 *
 * better-auth's `database` field accepts a D1Database directly (as well as a
 * Kysely instance / dialect), so passing `env.DB` is sufficient — no extra
 * adapter wiring needed.
 */
export type CirrusAuthOptions = BetterAuthOptions;

/**
 * The full better-auth instance: `auth.handler` accepts a `Request` and
 * returns a `Response` (used by `handleAuthRequest`); `auth.api`
 * exposes the typed endpoint surface for server-side calls (e.g.
 * `auth.api.getSession({ headers })` inside a query/mutation).
 */
export type CirrusAuth = ReturnType<typeof betterAuth>;

/**
 * Create the auth instance. Thin wrapper around `betterAuth` that enforces
 * the `secret` requirement at construction time so misconfigured deployments
 * fail loudly at the first fetch rather than the first sign-in attempt.
 */
export const createAuth = (options: CirrusAuthOptions): CirrusAuth => {
    if (!options.secret) {
        throw new Error("@cirrus/auth: `secret` is required");
    }

    return betterAuth(options);
};
