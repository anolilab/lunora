import type { LunoraAuthOptions } from "@lunora/auth";
import { createAuth, lunoraD1Adapter } from "@lunora/auth";
import { bearer } from "@lunora/auth/plugins";
import { expo } from "@better-auth/expo";

/** The app's URL scheme (see `app.json` → `expo.scheme`) — a trusted origin for native requests. */
const APP_SCHEME = "expoexample";

/**
 * Auth config shared by the runtime and migration instances.
 *
 * Email/password only, plus two better-auth plugins that make up the server half
 * of the native integration:
 *
 * - `expo()` marks the app scheme as a trusted origin and stops better-auth from
 *   rewriting the origin on native requests, so the sign-in the mobile client
 *   runs against `/api/auth/*` works.
 * - `bearer()` lets `getSession` authenticate from an `Authorization: Bearer`
 *   header, not just a cookie. The native client sends its session as a bearer
 *   token (React Native has no cookie jar, and a `Cookie` header would be
 *   rejected by the runtime's CSRF guard on an `Origin`-less native request) —
 *   see `src/lunora.ts` / `src/server/index.ts`.
 *
 * `trustedOrigins` lists the scheme explicitly.
 *
 * The password-reset delivery hook logs to the console — the standard dev
 * pattern. In production swap it for an `@lunora/mail` send.
 */
const options = (env: { AUTH_SECRET: string; AUTH_URL?: string }): LunoraAuthOptions => ({
    appName: "Lunora Expo Example",
    baseURL: env.AUTH_URL,
    emailAndPassword: {
        enabled: true,
        sendResetPassword: async ({ user }) => {
            // Log only a non-sensitive identifier — never the reset URL (a
            // credential) or the user's email (PII). In production swap this for
            // an `@lunora/mail` send that delivers the `url` to the user.
            // eslint-disable-next-line no-console
            console.log(`[auth] password reset requested for user ${user.id}`);
        },
    },
    plugins: [expo(), bearer()],
    secret: env.AUTH_SECRET,
    trustedOrigins: [`${APP_SCHEME}://`],
});

/**
 * Runtime auth instance, backed by `@lunora/auth`'s SQL adapter over D1.
 * `lunoraD1Adapter` wires the adapter explicitly so the better-auth Kysely
 * dynamic-import doesn't hang the dev server.
 */
export const buildAuth = (env: { AUTH_SECRET: string; AUTH_URL?: string; DB: unknown }): ReturnType<typeof createAuth> =>
    createAuth({ ...options(env), database: lunoraD1Adapter(env.DB as never) });

/**
 * Migration-only instance wired to raw D1 so `ensureMigrated`'s Kysely migrator
 * can create the better-auth tables the SQL adapter then reads/writes.
 */
export const buildMigrationAuth = (env: { AUTH_SECRET: string; AUTH_URL?: string; DB: unknown }): ReturnType<typeof createAuth> =>
    createAuth({ ...options(env), database: env.DB as never });
