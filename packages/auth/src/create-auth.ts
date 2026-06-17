import type { BetterAuthOptions } from "better-auth";
import { betterAuth } from "better-auth";

import { validateSessionPolicy } from "./session";

/**
 * A `secret` shorter than this is brute-forceable; better-auth itself accepts
 * any non-empty string. We throw on an HTTPS (production) deployment and warn on
 * a local `http://` spike, pointing at `openssl rand -hex 32` (32 bytes hex = 64
 * chars).
 */
const MIN_SECRET_LENGTH = 32;

/** True only for a non-empty secret below the recommended strength floor (measured after trimming, so surrounding whitespace never inflates the length). */
const isWeakSecret = (secret: string | undefined): boolean => {
    const trimmedLength = typeof secret === "string" ? secret.trim().length : 0;

    return trimmedLength > 0 && trimmedLength < MIN_SECRET_LENGTH;
};

/**
 * Whether the deployment's `baseURL` is confidently HTTPS — used to force
 * `Secure` cookies. Returns a plain boolean (no union) so it stays clear of
 * `sonarjs/function-return-type`: anything we can't positively prove is HTTPS
 * (a bare `http://`, an `"auto"`/missing protocol with no https fallback, or no
 * baseURL at all) is treated as not-secure, leaving the dev default untouched.
 */
const isHttpsBaseUrl = (baseURL: BetterAuthOptions["baseURL"]): boolean => {
    if (typeof baseURL === "string") {
        return baseURL.startsWith("https://");
    }

    if (baseURL && typeof baseURL === "object") {
        if (baseURL.protocol === "https") {
            return true;
        }

        if (baseURL.protocol === "http") {
            return false;
        }

        return typeof baseURL.fallback === "string" && baseURL.fallback.startsWith("https://");
    }

    return false;
};

/**
 * Apply Lunora's secure-by-default auth posture on top of the caller's options
 * without ever overriding an explicit choice.
 *
 * Cookie attributes: fill `httpOnly`, `sameSite: "lax"`, and `path: "/"` when
 * the caller hasn't supplied `advanced.defaultCookieAttributes`, so the hardened
 * posture is explicit and self-reportable rather than relying on better-auth
 * internals. `secure` is intentionally left to `useSecureCookies`.
 *
 * Secure cookies: force `useSecureCookies` on for an HTTPS `baseURL`.
 * better-auth's own default is "secure in production", but it detects production
 * via `process.env.NODE_ENV`, which is unreliable on Workers (the same reason
 * rate limiting is force-enabled below), so an HTTPS deploy could otherwise ship
 * session cookies without the `Secure` flag.
 *
 * CSRF/origin validation and `baseURL`-trusted-origins are already on by default
 * in better-auth, so we don't re-implement them here.
 */
const hardenAuthOptions = (options: BetterAuthOptions): BetterAuthOptions => {
    if (isWeakSecret(options.secret)) {
        const message =
            `@lunora/auth: AUTH_SECRET is only ${String(options.secret?.trim().length)} characters. Use at least ${String(MIN_SECRET_LENGTH)} ` +
            "for a brute-force-resistant secret — generate one with `openssl rand -hex 32`.";

        // A weak secret on an HTTPS (i.e. production) deployment is a real
        // brute-force exposure, not a dev inconvenience — fail loudly. Local
        // `http://` spikes keep the soft warning so a quick prototype isn't
        // blocked.
        if (isHttpsBaseUrl(options.baseURL)) {
            throw new Error(message);
        }

        // eslint-disable-next-line no-console
        console.warn(message);
    }

    const advanced = options.advanced ?? {};

    return {
        ...options,
        advanced: {
            ...advanced,
            defaultCookieAttributes: advanced.defaultCookieAttributes ?? { httpOnly: true, path: "/", sameSite: "lax" },
            ...(advanced.useSecureCookies === undefined && isHttpsBaseUrl(options.baseURL) ? { useSecureCookies: true } : {}),
        },
    };
};

/**
 * Lunora's options pass straight through to better-auth — the only thing we add
 * is requiring `secret` up front so a misconfigured deployment fails loudly
 * instead of at the first sign-in.
 *
 * For `database`, prefer `lunoraD1Adapter` (`database: lunoraD1Adapter(env.DB)`)
 * over passing the raw `env.DB`. better-auth *does* accept a D1Database directly,
 * but it then resolves its Kysely adapter via a runtime `await import(...)` inside
 * `auth.$context` — and that import never settles under `@cloudflare/vite-plugin`'s
 * worker runner, hanging every auth request in `pnpm dev`. The explicit adapter
 * skips it, so dev and prod behave the same. (Raw `env.DB` is still correct for
 * the migration-only instance — see `lunoraD1Adapter`'s note.)
 *
 * Session rotation / richer session policies are configured via the `session`
 * field (a `SessionPolicy`); Lunora validates it for obviously-broken
 * durations and forwards it verbatim to better-auth. See `sessionPresets`
 * for ready-made rotation/expiry trade-offs.
 *
 * ## Serverless background tasks (Cloudflare Workers)
 *
 * better-auth runs some work *after* sending the response — most importantly the
 * password-reset email, whose background send is what keeps reset responses
 * constant-time (a timing-attack defence: the response doesn't reveal whether
 * the account exists). On Cloudflare Workers a promise that isn't handed to
 * `ctx.waitUntil` can be cancelled the moment the response returns, dropping
 * that send and weakening the guarantee. Wire your request's `ctx.waitUntil`
 * into better-auth's background handler so the work survives:
 *
 * ```ts
 * // in your worker fetch handler, where `ctx: ExecutionContext` is in scope
 * const auth = createAuth({
 *     secret: env.AUTH_SECRET,
 *     database: lunoraD1Adapter(env.DB),
 *     advanced: {
 *         backgroundTasks: { handler: (promise) => ctx.waitUntil(promise) },
 *     },
 * });
 * ```
 *
 * (Lunora can't set this for you — `ctx.waitUntil` is per-request, but
 * `createAuth` runs once at worker setup.)
 */
export type LunoraAuthOptions = BetterAuthOptions;

/**
 * The full better-auth instance: `auth.handler` accepts a `Request` and
 * returns a `Response` (used by `handleAuthRequest`); `auth.api`
 * exposes the typed endpoint surface for server-side calls (e.g.
 * `auth.api.getSession({ headers })` inside a query/mutation).
 */
export type LunoraAuth = ReturnType<typeof betterAuth>;

/**
 * Create the auth instance. Thin wrapper around `betterAuth` that enforces
 * the `secret` requirement at construction time so misconfigured deployments
 * fail loudly at the first fetch rather than the first sign-in attempt.
 */
export const createAuth = (options: LunoraAuthOptions): LunoraAuth => {
    // Reject missing *and* whitespace-only secrets — a value like `" "` is
    // falsy-adjacent (it slips past `!options.secret`) but is just as
    // misconfigured, so fail loudly at construction time rather than at the
    // first sign-in attempt.
    if (!options.secret || options.secret.trim() === "") {
        throw new Error(
            "@lunora/auth: `secret` is required. Set AUTH_SECRET locally in .dev.vars " +
                '(`lunora env set AUTH_SECRET "$(openssl rand -hex 32)"`), and in production ' +
                "with `wrangler secret put AUTH_SECRET`.",
        );
    }

    // Catch obviously-broken session durations (negative / non-finite) at
    // construction time. Validation is a pass-through, so `options.session` is
    // forwarded to better-auth 1:1 — we don't reshape the object (which would
    // narrow better-auth's inferred `Auth<…>` type away from `LunoraAuth`).
    if (options.session) {
        validateSessionPolicy(options.session);
    }

    // Secure-by-default cookies + secret-strength warning, applied before the
    // rate-limit default so all hardening composes onto one options object.
    const hardened = hardenAuthOptions(options);

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
    const resolvedOptions: LunoraAuthOptions =
        hardened.rateLimit?.enabled === undefined ? { ...hardened, rateLimit: { ...hardened.rateLimit, enabled: true } } : hardened;

    return betterAuth(resolvedOptions);
};
