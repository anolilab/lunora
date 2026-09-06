import { LunoraError } from "@lunora/errors";
import type { BetterAuthOptions } from "better-auth";
import { betterAuth } from "better-auth";
import { getIP } from "better-auth/api";

import { onCloudflareEdge } from "../../../shared/on-cloudflare-edge";
import { validateSessionPolicy } from "./session";

/**
 * The client IP header Cloudflare's edge sets on every request it forwards,
 * overwriting whatever the client sent. Behind Cloudflare it is the one header a
 * client cannot choose, which is why `audit-hooks.ts`'s `resolveIp` reads it and
 * nothing else by default — this is the same policy, expressed in better-auth's
 * configuration instead of our own code, so the audit trail and the rate limiter
 * cannot disagree about who a request came from.
 *
 * That trust ends at the Cloudflare boundary. On a host that takes traffic
 * directly (the Node host, a bare container) nothing overwrites the header, so it
 * is whatever the client typed: rotate it and every request gets a fresh bucket;
 * send a non-IP and better-auth resolves nothing, landing the request in the
 * shared flood-cap bucket. Such a deployment must terminate at a proxy that sets
 * `cf-connecting-ip` itself, or declare `trustedProxies` so `x-forwarded-for`
 * carries the client — nothing in a request tells this package which case it is
 * in.
 */
const CLOUDFLARE_CLIENT_IP_HEADER = "cf-connecting-ip";

/**
 * Which headers better-auth may resolve a client IP from, when the caller has
 * not chosen for themselves.
 *
 * better-auth's own default is `["x-forwarded-for"]`, and `x-forwarded-for` is
 * whatever the client typed unless a proxy in front of us rewrote it. That has
 * two consequences and both are bad, in opposite directions:
 *
 * - Where the edge *appends* the real address to a client-supplied chain, the
 * header holds two or more entries, and with no `trustedProxies` configured
 * better-auth refuses to guess which is the client — it resolves nothing and
 * every such request lands in one shared `no-trusted-ip|<path>` bucket. At the
 * built-in 3-per-10s limit on `/sign-in*`, `/sign-up*`, `/change-password` and
 * `/change-email`, three unrelated clients exhaust it and the fourth is denied
 * sign-in on its first attempt.
 * - Where nothing rewrites the header at all, a single client-chosen value *is*
 * accepted, so an attacker rotates it and gets a fresh bucket per request —
 * the limit stops applying to exactly the traffic it exists to stop.
 *
 * Reading `cf-connecting-ip` first closes both without needing to know which of
 * the two a given edge does, because Cloudflare sets that header itself on every
 * request and a client cannot influence it — but only ON Cloudflare. Anywhere
 * else it is a header like any other, so trusting it there reintroduces the
 * second failure above verbatim: rotate the value, get a fresh bucket, and the
 * sign-in limit stops applying. It is therefore gated on
 * {@link onCloudflareEdge} rather than assumed, now that a Node host is a
 * supported target.
 *
 * `x-forwarded-for` comes back into the list only when the caller has declared
 * `trustedProxies`, which is what makes the chain interpretable: better-auth then
 * walks it right-to-left past the hops it was told to trust instead of trusting
 * the leftmost token. That is the non-Cloudflare answer — a Node/other host
 * behind a proxy configures its proxy addresses and gets per-client buckets —
 * and it mirrors `audit-hooks.ts`'s `trustProxyHeaders` opt-in rather than
 * inventing a second switch. Without it we do not silently trust a header the
 * client can write.
 */
const defaultIpAddressHeaders = (trustedProxies: ReadonlyArray<string> | undefined): string[] => {
    const proxied = trustedProxies !== undefined && trustedProxies.length > 0;

    if (!onCloudflareEdge()) {
        // Off Cloudflare, `cf-connecting-ip` is not set by anything — it is just
        // another header the client typed, so trusting it hands an attacker a
        // fresh rate-limit bucket per request and removes the sign-in limit
        // entirely. Without declared proxies there is no header here we can
        // believe, so resolve nothing and let those requests fall into the
        // shared `no-trusted-ip` bucket, which {@link UNRESOLVED_IP_BUCKET_FACTOR}
        // already sizes for exactly that case.
        return proxied ? ["x-forwarded-for"] : [];
    }

    return proxied ? [CLOUDFLARE_CLIENT_IP_HEADER, "x-forwarded-for"] : [CLOUDFLARE_CLIENT_IP_HEADER];
};

/**
 * Matches every auth path, so the fallback rule below is consulted for all of
 * them. `/*` would not: better-auth's glob treats `/` as a separator, so a
 * single star stops at the first one and never reaches `/sign-in/email`.
 */
const ALL_PATHS_RULE = "/**";

/**
 * How much wider the shared bucket is than the per-client rule it stands in for,
 * when no trustworthy client IP could be resolved at all.
 *
 * Some deployment forwards no header we trust — no Cloudflare edge, no declared
 * proxies. better-auth then keys every one of those requests to the single
 * `no-trusted-ip|<path>` bucket, and there are only two honest ways to treat a
 * bucket that every client shares. Sizing it for one client (the default) turns
 * the sign-in limit into a self-inflicted denial of service: the app breaks for
 * everybody as soon as a handful of people sign in at once. Dropping the limit
 * for those requests throws away the brute-force protection this package turns
 * on deliberately. So we keep the limit and re-size the bucket for what it
 * actually is — a coarse flood cap across all clients rather than a budget for
 * one — which bounds a credential-stuffing run without denying ordinary traffic.
 *
 * This is a floor, not a fix. The fix is to give better-auth a client IP it can
 * trust (`advanced.ipAddress.ipAddressHeaders` / `trustedProxies`), which is also
 * what better-auth's own one-time warning on this path asks for. Per-client
 * limiting cannot be recovered from headers that are not there.
 */
const UNRESOLVED_IP_BUCKET_FACTOR = 100;

type RateLimitRules = NonNullable<NonNullable<BetterAuthOptions["rateLimit"]>["customRules"]>;

/**
 * The caller's `customRules` plus a {@link ALL_PATHS_RULE} catch-all that widens
 * the bucket by {@link UNRESOLVED_IP_BUCKET_FACTOR} when no client IP resolved.
 * The caller's rules come first on purpose: better-auth takes the FIRST key whose
 * pattern matches the path, so theirs win over the catch-all rather than being
 * shadowed by it. A caller who declared the catch-all themselves keeps it.
 */
const withUnresolvedIpFloodCap = (options: LunoraAuthOptions): RateLimitRules => {
    const rules = options.rateLimit?.customRules ?? {};

    if (rules[ALL_PATHS_RULE] !== undefined) {
        return rules;
    }

    return {
        ...rules,
        [ALL_PATHS_RULE]: (request: Request, rule: { max: number; window: number }) =>
            getIP(request, options) === null ? { max: rule.max * UNRESOLVED_IP_BUCKET_FACTOR, window: rule.window } : rule,
    };
};

/**
 * A `secret` shorter than this is brute-forceable; better-auth itself accepts
 * any non-empty string. We throw on anything not proven to be a local dev origin
 * (HTTPS *and* an unset `baseURL` both count as production) and only warn on an
 * explicit `http://` spike, pointing at `openssl rand -hex 32` (32 bytes hex = 64
 * chars).
 */
const MIN_SECRET_LENGTH = 32;

/** True only for a non-empty secret below the recommended strength floor (measured after trimming, so surrounding whitespace never inflates the length). */
const isWeakSecret = (secret: string | undefined): boolean => {
    const trimmedLength = typeof secret === "string" ? secret.trim().length : 0;

    return trimmedLength > 0 && trimmedLength < MIN_SECRET_LENGTH;
};

/**
 * Whether the deployment's `baseURL` is *explicitly* insecure `http://` (a local
 * dev origin). Used to decide the `useSecureCookies` DEFAULT: anything NOT proven
 * to be plain `http://` is treated as secure, because Cloudflare Workers serve
 * over HTTPS in production and `baseURL` is very commonly unset (better-auth then
 * infers it per-request). This inverts the previous "only secure when a positively
 * HTTPS baseURL is set" logic, which left an unset-baseURL production deploy
 * shipping session cookies without the `Secure` flag (better-auth's own fallback
 * keys off the unreliable `NODE_ENV` on Workers). Returns a plain boolean to stay
 * clear of `sonarjs/function-return-type`.
 */
const isExplicitHttpBaseUrl = (baseURL: BetterAuthOptions["baseURL"]): boolean => {
    if (typeof baseURL === "string") {
        // Scheme comparison is case-insensitive (RFC 3986): `HTTP://…` is
        // still plain HTTP and must not slip through as "secure".
        return baseURL.toLowerCase().startsWith("http://");
    }

    if (baseURL && typeof baseURL === "object") {
        if (baseURL.protocol === "http") {
            return true;
        }

        if (baseURL.protocol === "https") {
            return false;
        }

        return typeof baseURL.fallback === "string" && baseURL.fallback.toLowerCase().startsWith("http://");
    }

    return false;
};

/**
 * Hostnames that can only ever address the developer's own machine, so a
 * `baseURL` on one of them is a local dev origin rather than a deployment.
 */
const LOCAL_DEV_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);

/**
 * better-auth's dynamic `baseURL` form, narrowed to the shape we build. Declared
 * as its own type so {@link portAgnosticLocalBaseUrl} has a single return type
 * (`sonarjs/function-return-type`) instead of a string-or-object union.
 */
interface PortAgnosticLocalBaseUrl {
    allowedHosts: string[];
    fallback: string;
    protocol: "http";
}

/**
 * Let a hardcoded local `baseURL` follow the port the dev server actually bound,
 * or `undefined` when the caller's value should be used as-is.
 *
 * `.dev.vars` pins a concrete origin (`AUTH_URL="http://localhost:5173"`), but
 * Vite falls back to the next free port when that one is taken — so a second app,
 * or a leaked server from an earlier session, silently moves the dev server to
 * `:5174` while better-auth keeps resolving callbacks against `:5173`. The
 * session cookie is then set on an origin the browser is never on, so nothing
 * that needs an identity works: sign-in appears to succeed and every subsequent
 * request is anonymous — including the WebSocket upgrade, whose `authorizeShard`
 * rejects it (a `403` that `@cloudflare/vite-plugin` turns into a bare socket
 * close, hiding the cause).
 *
 * Rewriting the string into better-auth's dynamic form makes it derive the origin
 * from the request, which carries the port actually in use. `allowedHosts` is what
 * keeps the attacker-controllable `Host` header from becoming the base URL: only
 * the same loopback hostname, on any port, is accepted, and anything else falls
 * back to the configured value. Scoped to explicit `http://` loopback origins, so
 * a deployed HTTPS `baseURL` passes through untouched.
 */
const portAgnosticLocalBaseUrl = (baseURL: BetterAuthOptions["baseURL"]): PortAgnosticLocalBaseUrl | undefined => {
    if (typeof baseURL !== "string") {
        return undefined;
    }

    let parsed: URL;

    try {
        parsed = new URL(baseURL);
    } catch {
        // Not a parseable absolute URL — leave it exactly as the caller wrote it
        // and let better-auth surface its own error.
        return undefined;
    }

    if (parsed.protocol !== "http:" || !LOCAL_DEV_HOSTNAMES.has(parsed.hostname)) {
        return undefined;
    }

    // The bare hostname covers the default-port case (`http://localhost`), which
    // the `:*` pattern does not match — better-auth compares against the `Host`
    // header verbatim, and that omits the port on 80.
    return { allowedHosts: [parsed.hostname, `${parsed.hostname}:*`], fallback: baseURL, protocol: "http" };
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
 * Secure cookies: default `useSecureCookies` ON unless `baseURL` is *explicitly*
 * plain `http://` (a local dev origin). better-auth's own default is "secure in
 * production", but it detects production via `process.env.NODE_ENV`, which is
 * unreliable on Workers (the same reason rate limiting is force-enabled below),
 * so a common unset-`baseURL` production deploy could otherwise ship session
 * cookies without the `Secure` flag. Workers serve HTTPS in production, so the
 * safe default is secure-unless-proven-http. An explicit caller
 * `advanced.useSecureCookies` always wins.
 *
 * CSRF/origin validation and `baseURL`-trusted-origins are already on by default
 * in better-auth, so we don't re-implement them here.
 *
 * That includes the common Workers shape with `baseURL` unset: better-auth trusts the
 * request's own origin, recomputed per request, so sign-in works on a fresh deploy with
 * nothing configured. CSRF still holds — the trusted origin is derived from the `Host`
 * the browser connected to, which page JS cannot forge, so a cross-site `Origin` never
 * matches. (The `BETTER_AUTH_URL` family and `BETTER_AUTH_TRUSTED_ORIGINS` can pre-empt
 * or widen that list, but they are operator-set and not attacker-reachable.)
 *
 * Do **not** add a `trustedOrigins` default here on the assumption that the
 * context-time list is empty — it is, and it doesn't matter. The mechanism and the
 * pin live in `__tests__/trusted-origins.behaviour.test.ts`.
 *
 * Base URL: an explicit local `http://` origin is made port-agnostic via
 * {@link portAgnosticLocalBaseUrl} so dev survives Vite picking a different port.
 * That is the *set*-`baseURL` counterpart to the unset case above, and it reaches
 * the same place — an origin derived per request from `Host`, just with
 * `allowedHosts` bounding it. The rewrite keeps `protocol: "http"`, so it stays
 * "explicitly http" for both checks below and the hardening decisions are
 * unchanged. It adds no `trustedOrigins` default either: the `http://localhost:*`
 * entry comes from better-auth's own dynamic-config handling.
 */
const hardenAuthOptions = (options: BetterAuthOptions): BetterAuthOptions => {
    const baseURL = portAgnosticLocalBaseUrl(options.baseURL) ?? options.baseURL;

    if (isWeakSecret(options.secret)) {
        const message =
            `@lunora/auth: AUTH_SECRET is only ${String(options.secret?.trim().length)} characters. Use at least ${String(MIN_SECRET_LENGTH)} ` +
            "for a brute-force-resistant secret — generate one with `openssl rand -hex 32`.";

        // A weak secret on anything not proven to be a local dev origin is a
        // real brute-force exposure, not a dev inconvenience — fail loudly.
        // Mirrors the `useSecureCookies` default below: HTTPS *and* an unset
        // `baseURL` (the common Cloudflare Workers production shape, where
        // better-auth infers the origin per-request over HTTPS) both count as
        // production. Only an explicit `http://` local origin keeps the soft
        // warning so a quick prototype isn't blocked.
        if (!isExplicitHttpBaseUrl(baseURL)) {
            throw new LunoraError("INTERNAL", message);
        }

        // eslint-disable-next-line no-console
        console.warn(message);
    }

    const advanced = options.advanced ?? {};
    const ipAddress = advanced.ipAddress ?? {};

    return {
        ...options,
        advanced: {
            ...advanced,
            defaultCookieAttributes: advanced.defaultCookieAttributes ?? { httpOnly: true, path: "/", sameSite: "lax" },
            ipAddress: {
                ...ipAddress,
                ...(ipAddress.ipAddressHeaders === undefined ? { ipAddressHeaders: defaultIpAddressHeaders(ipAddress.trustedProxies) } : {}),
            },
            ...(advanced.useSecureCookies === undefined ? { useSecureCookies: !isExplicitHttpBaseUrl(baseURL) } : {}),
        },
        baseURL,
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
 * Resolve the caller's options into the exact shape `createAuth` hands to
 * `betterAuth` — the hardened, default-filled options the running worker uses.
 * Exported (and pure) so the migration path can compile the schema from the
 * same resolved options: `compileMigrationsSql` routes through here, so the
 * `rateLimit` table the worker's durable limiter writes to is included in the
 * migration rather than silently omitted (it would be, if migrations saw the
 * raw options while the worker ran the resolved ones).
 *
 * ## What it fills (each gated independently on caller silence)
 *
 * Secure-by-default cookies + secret-strength warning via {@link hardenAuthOptions},
 * applied first so all hardening composes onto one options object.
 *
 * Rate limiting is ON by default for `/api/auth/*`.
 *
 * better-auth's own default is `rateLimit.enabled ?? isProduction`, and its
 * `isProduction` is `process.env.NODE_ENV === "production"` resolved at
 * module-load time. On Cloudflare Workers that check is unreliable: the
 * runtime has no Node `process.env` (absent entirely without
 * `nodejs_compat`, and even with it `NODE_ENV` is rarely `"production"` at
 * request time). So better-auth would silently leave auth endpoints
 * _unthrottled_ on a real deployment — the surprise we refuse to ship.
 *
 * We therefore default `enabled: true` whenever the caller hasn't made an
 * explicit choice. We only fill the `enabled` flag and otherwise forward
 * the caller's `rateLimit` verbatim, so better-auth's `window` (10s) / `max`
 * (100) defaults and any custom rules still apply. Callers who genuinely
 * want it off can pass `rateLimit: { enabled: false }` (e.g. when fronting
 * auth with their own limiter), and any explicit `enabled` value wins.
 *
 * We also default `storage: "database"` — but only when rate limiting is not
 * explicitly disabled (`enabled !== false`). Filling storage under a disabled
 * limiter is harmless at runtime but makes `getAuthTables` emit an unused
 * `rateLimit` table, so we skip it there.
 *
 * better-auth's own default is `storage: "memory"` — a per-isolate,
 * non-durable counter. On Cloudflare Workers that means each isolate keeps
 * its own tally, counters vanish on isolate recycle, and traffic spread
 * across isolates never sums to the configured `max` — a limiter that
 * reports "enabled" while never enforcing a global limit (the exact
 * brute-force / credential-stuffing protection on `/sign-in`, OTP, and
 * password-reset it is meant to buy). `storage: "database"` rides the counter
 * through the configured `database` adapter — Lunora's store over the D1 auth
 * tables — so the limit is durable *and* atomic (the store's native
 * `incrementOne` gives a one-winner guarantee across isolates). Callers with
 * their own durable store can pass an explicit `rateLimit: { storage: … }`
 * (or `customStorage`), and any explicit value wins.
 *
 * The limiter's *bucket key* is filled here too, and it is the half that makes
 * the rest of the paragraph above true. A limit is only brute-force protection
 * if the key identifies the client, so {@link defaultIpAddressHeaders} points
 * better-auth at `cf-connecting-ip` instead of its own `x-forwarded-for`
 * default, and {@link UNRESOLVED_IP_BUCKET_FACTOR} re-sizes the shared bucket
 * for the deployments where no client IP can be resolved at all. Both are read
 * off `advanced.ipAddress`, so a caller who configures that keeps their own
 * policy end to end. The catch-all `customRules` entry is merged *after* the
 * caller's own rules so theirs match first.
 *
 * Session cookie cache is ON by default too.
 *
 * Every authenticated call resolves identity through better-auth's
 * `getSession`, which — without a cache — is a DB (D1) read on the hot path
 * of every query/mutation/action that reads `ctx.auth` and of the WebSocket
 * upgrade. better-auth's `session.cookieCache` carries the session payload in
 * a short-lived signed cookie so `getSession` can answer without hitting the
 * database until the cache window elapses. We default it on with a
 * deliberately short 60s `maxAge` (better-auth's own default is 300s): long
 * enough to erase the per-request read for a burst of calls, short enough
 * that a revoked or role-changed session self-corrects within a minute.
 * The one tradeoff — a revoked session stays valid until the cache expires —
 * is bounded by that TTL; callers who need immediate revocation opt out with
 * `session: { cookieCache: { enabled: false } }` (or the `strict` preset).
 *
 * Every explicit caller value is forwarded verbatim. The `rateLimit` fills all
 * merge into a single `rateLimit` object so none clobbers the others.
 */
export const resolveAuthOptions = (options: LunoraAuthOptions): LunoraAuthOptions => {
    const hardened = hardenAuthOptions(options);

    const needsRateLimitEnabled = hardened.rateLimit?.enabled === undefined;
    // Only fill `storage` when the caller hasn't disabled rate limiting — a
    // disabled limiter with a `"database"` storage otherwise pushes an unused
    // `rateLimit` table into `getAuthTables` / the compiled migration.
    const needsRateLimitStorage = hardened.rateLimit?.storage === undefined && hardened.rateLimit?.enabled !== false;

    const rateLimit =
        hardened.rateLimit?.enabled === false
            ? {}
            : {
                  rateLimit: {
                      ...hardened.rateLimit,
                      ...(needsRateLimitEnabled ? { enabled: true } : {}),
                      ...(needsRateLimitStorage ? { storage: "database" as const } : {}),
                      customRules: withUnresolvedIpFloodCap(hardened),
                  },
              };

    return {
        ...hardened,
        ...rateLimit,
        ...(hardened.session?.cookieCache === undefined ? { session: { ...hardened.session, cookieCache: { enabled: true, maxAge: 60 } } } : {}),
    };
};

/**
 * Create the auth instance. Thin wrapper around `betterAuth` that enforces
 * the `secret` requirement at construction time so misconfigured deployments
 * fail loudly at the first fetch rather than the first sign-in attempt, then
 * hands {@link resolveAuthOptions}'s hardened, default-filled options to
 * better-auth.
 */
export const createAuth = (options: LunoraAuthOptions): LunoraAuth => {
    // Reject missing *and* whitespace-only secrets — a value like `" "` is
    // falsy-adjacent (it slips past `!options.secret`) but is just as
    // misconfigured, so fail loudly at construction time rather than at the
    // first sign-in attempt.
    if (!options.secret || options.secret.trim() === "") {
        throw new LunoraError(
            "INTERNAL",
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

    return betterAuth(resolveAuthOptions(options));
};
