import type { BetterAuthOptions } from "better-auth";
import { betterAuth } from "better-auth";

import { validateSessionPolicy } from "./session.js";

/**
 * Cirrus's options pass straight through to better-auth — the only thing we
 * provide is the convention that `database` defaults to `env.DB` (a Cloudflare
 * D1 binding) and `secret` is required so we surface a clear error if it's
 * missing instead of letting better-auth's runtime check fire later.
 *
 * better-auth's `database` field accepts a D1Database directly (as well as a
 * Kysely instance / dialect), so passing `env.DB` is sufficient — no extra
 * adapter wiring needed.
 *
 * Session rotation / richer session policies are configured via the `session`
 * field (a `SessionPolicy`); Cirrus validates it for obviously-broken
 * durations and forwards it verbatim to better-auth. See `sessionPresets`
 * for ready-made rotation/expiry trade-offs.
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
    // Reject missing *and* whitespace-only secrets — a value like `" "` is
    // falsy-adjacent (it slips past `!options.secret`) but is just as
    // misconfigured, so fail loudly at construction time rather than at the
    // first sign-in attempt.
    if (!options.secret || options.secret.trim() === "") {
        throw new Error("@cirrus/auth: `secret` is required");
    }

    // Catch obviously-broken session durations (negative / non-finite) at
    // construction time. Validation is a pass-through, so `options.session` is
    // forwarded to better-auth 1:1 — we don't reshape the object (which would
    // narrow better-auth's inferred `Auth<…>` type away from `CirrusAuth`).
    if (options.session) {
        validateSessionPolicy(options.session);
    }

    return betterAuth(options);
};
