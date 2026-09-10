/**
 * The control plane's better-auth instance, and the one place it is built.
 *
 * Extracted from `server.ts` because two callers need it and one of them cannot
 * import that module: `deploy/router.ts` mints a sign-up invitation when an org
 * invite names an address with no account yet, and `server.ts` already imports
 * the router — so reaching back the other way would be a cycle. Both import
 * this instead.
 *
 * The lazy singleton lives here for the same reason it lived there: an isolate
 * must build the instance once, and readiness also requires the schema
 * migration to have finished.
 */

import type { LunoraAuth, LunoraAuthOptions } from "@lunora/auth";
import { createAuth, ensureMigrated, lunoraD1Adapter } from "@lunora/auth";
import { admin, inviteOnly, passkey, twoFactor } from "@lunora/auth/plugins";
import { createMailerFromEnv } from "@lunora/mail";

/**
 * The slice of the worker `env` the auth build reads.
 *
 * Structural rather than an import of `server.ts`'s `Env`, so this module owns
 * its own contract — and so `deploy/router.ts`, whose `RouterEnv` is a different
 * shape, can satisfy it.
 */
export interface AuthEnv extends Record<string, unknown> {
    AUTH_SECRET?: string;
    AUTH_URL?: string;
    DB: unknown;
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    MAIL_FROM?: string;
    /** `"development"` under `lunora dev`; read by the invite gate's bootstrap carve-out. */
    WORKER_ENV?: string;
}

/** Build the OAuth provider map from env — only providers with creds are enabled. */
const socialProviders = (env: AuthEnv): LunoraAuthOptions["socialProviders"] => {
    const providers: NonNullable<LunoraAuthOptions["socialProviders"]> = {};

    if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
        providers.github = { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET };
    }

    if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
        providers.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
    }

    return Object.keys(providers).length > 0 ? providers : undefined;
};

/**
 * Better-auth config backing the hosted studio (§3). Hardened beyond bare
 * email/password: password-reset + email-verification mail route through
 * `@lunora/mail` (captured into the studio Mail tab in dev), optional GitHub/
 * Google OAuth when configured, better-auth's built-in request rate limiting,
 * and the `admin` (user management) / `twoFactor` / `passkey` plugins the
 * studio's auth dashboard adapts to. Org membership stays the Lunora
 * `organizations`/`members` model — the better-auth `organization` plugin is
 * deliberately omitted to avoid two parallel org models.
 */
const authOptions = (env: AuthEnv, requestOrigin?: string): LunoraAuthOptions => {
    if (!env.AUTH_SECRET) {
        throw new Error("AUTH_SECRET is required");
    }

    // Built lazily inside each callback (not here): `createMailerFromEnv` throws
    // when no transport is configured (e.g. prod without MAIL_FROM), and we don't
    // want that to take down auth — only the individual email send.
    const mailer = (): ReturnType<typeof createMailerFromEnv> => createMailerFromEnv(env);

    return {
        // Falls back to the origin of the request that built this isolate's auth
        // instance. Without a baseURL better-auth derives the origin per request and
        // warns that callbacks/redirects may misbehave; in dev nothing can hardcode
        // it, because Vite moves to 5175+ whenever the port is taken. An explicit
        // `AUTH_URL` still wins, which is what production sets.
        baseURL: env.AUTH_URL ?? requestOrigin,
        emailAndPassword: {
            enabled: true,
            /*
             * An invitation is keyed by email address, so verification is what
             * stops a leaked invited address from becoming a usable session:
             * better-auth writes the user row BEFORE it mails the token, and
             * without this the person who signed up holds a session the moment
             * they do. `inviteOnly()` warns on boot when this is off, and the
             * warning is right.
             *
             * The invite token already closes `/sign-up/email` against a
             * bulk-guessed address; this closes the gap on every other path the
             * `user.create.before` backstop admits.
             */
            requireEmailVerification: true,
            // Mail the reset link; in dev it's captured into the studio Mail tab.
            sendResetPassword: async ({ url, user }) => {
                await mailer().send({ subject: "Reset your Lunora Cloud password", text: `Reset your password:\n${url}`, to: user.email });
            },
        },
        emailVerification: {
            sendOnSignUp: true,
            sendVerificationEmail: async ({ url, user }) => {
                await mailer().send({ subject: "Verify your Lunora Cloud email", text: `Verify your email:\n${url}`, to: user.email });
            },
        },
        // Resolve the client IP from Cloudflare's own header. Without this
        // better-auth cannot determine an address, and its rate limiting silently
        // degrades to a SINGLE shared bucket per path — so the throttle the line
        // below claims to be "per-IP" was really global: one attacker hammering
        // sign-in exhausted the limit for every legitimate user, and per-attacker
        // brute-force protection did not exist. `cf-connecting-ip` is set by the
        // edge and cannot be spoofed by the client on Workers.
        advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
        /*
         * `inviteOnly()` makes account creation a PLATFORM decision: no row is
         * written for an address with no unspent invitation, whatever minted it
         * — `/sign-up/email`, an OAuth callback, or `AuthAdmin.createUser`. It
         * also declares the `signUpInvitation` table, so `ensureMigrated` below
         * provisions it with nothing further to write, and it lights up the
         * operator surface that is already wired here: `createAuthAdmin` grows
         * `create/list/revokeSignUpInvitation`, the runtime exposes them as
         * admin routes, and the studio renders its sign-up-invitations panel off
         * `capabilities.inviteOnly`.
         *
         * Deliberately NOT bridged to `lunora/invitations.ts`. Those are TENANT
         * invitations — an org owner adding someone to their org — and minting a
         * sign-up invitation from one would let any org admin create accounts on
         * a cell whose whole point is that they cannot. An invited teammate who
         * has no account yet needs a sign-up invitation from an operator; the
         * org invitation is what admits them to the org once they do.
         *
         * `allowFirstUser` only in dev, where `scripts/seed.ts` signs its user up
         * through the real endpoint on a database that has none. In production
         * the carve-out is a race between deploying and the owner signing up, so
         * the first invitation is seeded by hand instead.
         */
        plugins: [admin({ defaultRole: "user" }), inviteOnly({ allowFirstUser: env.WORKER_ENV === "development" }), twoFactor(), passkey()],
        // Built-in per-IP throttling on the auth endpoints (sign-in/up, reset).
        rateLimit: { enabled: true },
        secret: env.AUTH_SECRET,
        socialProviders: socialProviders(env),
    };
};

let auth: LunoraAuth | null = null;

/**
 * The in-flight (or settled) auth bootstrap for this isolate.
 *
 * Separate from {@link auth} because the instance becomes visible the moment it is
 * assigned, while readiness also requires the schema migration to have finished —
 * two different facts that a single nullable instance cannot distinguish.
 */
let authReady: Promise<LunoraAuth> | null = null;

/**
 * Build (once per isolate) and return the auth instance, schema already
 * migrated. Every concurrent caller awaits the same promise.
 *
 * The previous form assigned the instance and then awaited the migration, so on
 * a cold isolate every request that arrived during that await saw a non-null
 * instance, skipped the block, and queried tables the migration had not finished
 * creating — surfacing as a raw database error rather than an auth one. Holding
 * the promise rather than the instance is what makes "ready" and "assigned" the
 * same moment.
 */
export const ensureAuth = async (env: AuthEnv, requestOrigin: string): Promise<LunoraAuth> => {
    authReady ??= (async (): Promise<LunoraAuth> => {
        // Runtime auth instance uses the SQL adapter; a throwaway instance on
        // the raw D1 drives the one-time schema migration (better-auth Kysely).
        const instance = createAuth({ ...authOptions(env, requestOrigin), database: lunoraD1Adapter(env.DB as never) });

        await ensureMigrated(createAuth({ ...authOptions(env, requestOrigin), database: env.DB as never }));

        return instance;
    })();

    auth = await authReady;

    return auth;
};

/**
 * The instance {@link ensureAuth} built, or `null` before the first request has
 * finished bootstrapping it.
 *
 * Safe to treat as non-null from inside a request handler: the worker awaits
 * `ensureAuth` in `fetch` before it dispatches anything, so every route — the
 * auth plane, the `httpRouter`, the SSR handler — runs strictly after. It stays
 * nullable in the type because a cron or queue invocation reaches the worker
 * without going through `fetch`.
 */
export const currentAuth = (): LunoraAuth | null => auth;
