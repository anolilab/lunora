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

    // Rate limiting is ON by default for `/api/auth/*`.
    //
    // better-auth's own default is `rateLimit.enabled ?? isProduction`, and its
    // `isProduction` is `process.env.NODE_ENV === "production"` resolved at
    // module-load time. On Cloudflare Workers that check is unreliable: the
    // runtime has no Node `process.env` (absent entirely without
    // `nodejs_compat`, and even with it `NODE_ENV` is rarely `"production"` at
    // request time). So better-auth would silently leave auth endpoints
    // *unthrottled* on a real deployment — the surprise we refuse to ship.
    //
    // We therefore default `enabled: true` whenever the caller hasn't made an
    // explicit choice. We only fill the `enabled` flag and otherwise forward
    // the caller's `rateLimit` verbatim, so better-auth's `window` (10s) / `max`
    // (100) defaults and any custom rules still apply. Callers who genuinely
    // want it off can pass `rateLimit: { enabled: false }` (e.g. when fronting
    // auth with their own limiter), and any explicit `enabled` value wins.
    const resolvedOptions: CirrusAuthOptions =
        options.rateLimit?.enabled === undefined
            ? { ...options, rateLimit: { ...options.rateLimit, enabled: true } }
            : options;

    return betterAuth(resolvedOptions);
};
