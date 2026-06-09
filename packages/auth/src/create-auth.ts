import type { BetterAuthOptions } from "better-auth";
import { betterAuth } from "better-auth";

import { validateSessionPolicy } from "./session";

/**
 * Cirrus's options pass straight through to better-auth — the only thing we add
 * is requiring `secret` up front so a misconfigured deployment fails loudly
 * instead of at the first sign-in.
 *
 * For `database`, prefer `cirrusD1Adapter` (`database: cirrusD1Adapter(env.DB)`)
 * over passing the raw `env.DB`. better-auth *does* accept a D1Database directly,
 * but it then resolves its Kysely adapter via a runtime `await import(...)` inside
 * `auth.$context` — and that import never settles under `@cloudflare/vite-plugin`'s
 * worker runner, hanging every auth request in `pnpm dev`. The explicit adapter
 * skips it, so dev and prod behave the same. (Raw `env.DB` is still correct for
 * the migration-only instance — see `cirrusD1Adapter`'s note.)
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
        throw new Error(
            "@cirrus/auth: `secret` is required. Set AUTH_SECRET locally in .dev.vars " +
                '(`cirrus env set AUTH_SECRET "$(openssl rand -hex 32)"`), and in production ' +
                "with `wrangler secret put AUTH_SECRET`.",
        );
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
