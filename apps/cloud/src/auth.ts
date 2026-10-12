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

import { afterAccountDeletion, beforeAccountDeletion } from "./account-deletion";
import { adminRemovalGuard } from "./admin-removal";
import { ADMIN_ROLES } from "./admin-roles";

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
    /** Authorizes the account-deletion hook's in-process call to `POST /v1/account/erase`. */
    LUNORA_ADMIN_TOKEN?: string;
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
         *
         * `adminRemovalGuard` holds the admin plugin's `/admin/remove-user` to the
         * same owner rule and cleanup as a self-service deletion, which that
         * endpoint skips (`src/admin-removal.ts`). Its permission check reads the
         * same `ADMIN_ROLES` map this plugin is given (`src/admin-roles.ts`), so a
         * role change cannot leave the two out of step. `adminUserIds` is not used.
         */
        plugins: [
            admin({ defaultRole: "user", roles: ADMIN_ROLES }),
            adminRemovalGuard(env),
            inviteOnly({ allowFirstUser: env.WORKER_ENV === "development" }),
            twoFactor(),
            passkey(),
        ],
        // Built-in per-IP throttling on the auth endpoints (sign-in/up, reset).
        rateLimit: { enabled: true },
        secret: env.AUTH_SECRET,
        socialProviders: socialProviders(env),
        /*
         * Self-service account deletion (the auth UI's delete-account flow). The
         * before hook runs before any auth row is removed and refuses while the
         * user is the only owner of an organization; the after hook clears what
         * the control plane holds under the user id once the account is gone
         * (`src/account-deletion.ts` has the ordering). Built here, over this
         * `env`, so every entry that builds the instance (fetch, the build runner,
         * a cron) carries them.
         */
        user: { deleteUser: { afterDelete: afterAccountDeletion(env), beforeDelete: beforeAccountDeletion(env), enabled: true } },
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
 * The promise is held, not the instance. Assigning the instance before the migration
 * finishes would let a request that arrives during the await see a non-null instance,
 * skip the block, and query tables the migration has not created yet, surfacing as a
 * raw database error rather than an auth one. Holding the promise makes "ready" and
 * "assigned" the same moment.
 */
export const ensureAuth = async (env: AuthEnv, requestOrigin: string): Promise<LunoraAuth> => {
    authReady ??= (async (): Promise<LunoraAuth> => {
        // Runtime auth instance uses the SQL adapter; a throwaway instance on
        // the raw D1 drives the one-time schema migration (better-auth Kysely).
        const instance = createAuth({ ...authOptions(env, requestOrigin), database: lunoraD1Adapter(env.DB as never) });

        await ensureMigrated(createAuth({ ...authOptions(env, requestOrigin), database: env.DB as never }));

        return instance;
    })().catch((error: unknown) => {
        // A failed migration must not stay cached: the next request retries the setup
        // instead of rethrowing the same rejection for the life of the isolate.
        authReady = null;

        throw error;
    });

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

/**
 * Look up users' email addresses in the auth plane, for alerts that go to an
 * organization's owners and admins (`ORG_ADMINS_DESTINATION`). Works outside a
 * request too — the alert drain runs on a cron — by bootstrapping the instance
 * the way the build runner does, so the auth plane's own model names apply.
 */
export const authUserEmails =
    (env: AuthEnv) =>
    async (userIds: ReadonlyArray<string>): Promise<string[]> => {
        const origin = typeof env["LUNORA_ORIGIN_URL"] === "string" ? env["LUNORA_ORIGIN_URL"] : (env.AUTH_URL ?? "https://control-plane.internal");
        const instance = await ensureAuth(env, new URL(origin).origin);
        const context = await instance.$context;
        const users = await Promise.all(
            userIds.map(async (id) => context.adapter.findOne<{ email?: string }>({ model: "user", where: [{ field: "id", value: id }] })),
        );

        return users.flatMap((user) => (typeof user?.email === "string" ? [user.email] : []));
    };

/** Ids per `in` lookup: D1 caps a statement at 100 bound parameters. */
const USER_LOOKUP_CHUNK = 90;

/**
 * Which of `userIds` still have a user row in the auth plane, for the
 * orphaned-membership sweep. Bootstraps the instance the way
 * {@link authUserEmails} does. A failed lookup rejects rather than answering
 * an empty set: the caller treats an absent id as a deleted account and erases
 * it, so a partial answer must never reach it.
 */
export const authExistingUserIds =
    (env: AuthEnv) =>
    async (userIds: ReadonlyArray<string>): Promise<Set<string>> => {
        const origin = typeof env["LUNORA_ORIGIN_URL"] === "string" ? env["LUNORA_ORIGIN_URL"] : (env.AUTH_URL ?? "https://control-plane.internal");
        const instance = await ensureAuth(env, new URL(origin).origin);
        const context = await instance.$context;
        const existing = new Set<string>();

        for (let start = 0; start < userIds.length; start += USER_LOOKUP_CHUNK) {
            const chunk = userIds.slice(start, start + USER_LOOKUP_CHUNK);
            // eslint-disable-next-line no-await-in-loop -- one bounded lookup at a time
            const users = await context.adapter.findMany<{ id?: unknown }>({ model: "user", where: [{ field: "id", operator: "in", value: chunk }] });

            for (const user of users) {
                if (typeof user.id === "string") {
                    existing.add(user.id);
                }
            }
        }

        return existing;
    };
