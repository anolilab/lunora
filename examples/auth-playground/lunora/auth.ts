import type { LunoraAuthOptions } from "@lunora/auth";
import { lunoraD1Adapter, createAuth } from "@lunora/auth";
import { admin, organization, twoFactor } from "@lunora/auth/plugins";

/** Shown in authenticator apps (2FA issuer) and as the default email "from" name. */
const APP_NAME = "Lunora Auth Playground";

/**
 * Auth config shared by the runtime and migration instances. The plugin list is
 * what gives this playground its admin panel, organization, and 2FA features:
 *
 * - `organization()` adds orgs, members, invitations + a slate of endpoints
 *   reachable through `auth.api.createOrganization` / `inviteMember` / …
 *   `sendInvitationEmail` is the delivery hook the `inviteMember` flow needs.
 * - `admin()` adds the ban/impersonate surface; the first user we sign up
 *   below is promoted to `role: "admin"` via the seeded `adminUserIds` list.
 * - `twoFactor()` adds TOTP + email/SMS OTP; `issuer` is the authenticator-app
 *   label and `otpOptions.sendOTP` is the OTP delivery hook.
 *
 * Delivery hooks here log to the console — the standard dev pattern that
 * demonstrates the required wiring without a mail provider. In production swap
 * the `console.log` bodies for an `@lunora/mail` send (and set
 * `requireEmailVerification` / a real `sendResetPassword`). The twoFactor +
 * organization tables are auto-discovered by `getAuthTables` and migrated by
 * `ensureMigrated`, so adding these plugins needs no hand-written schema.
 *
 * Polar billing is intentionally NOT included — if you need it, install
 * `@polar-sh/better-auth` and add `polar()` to the `plugins` array.
 *
 * The CLIENT half of these plugins (`organizationClient`, `twoFactorClient`,
 * `adminClient`) must be registered on `createAuthClient` from
 * `@lunora/auth/plugins/client` to use `authClient.organization.*` /
 * `authClient.twoFactor.*` and the 2FA sign-in redirect.
 */
const options = (env: { AUTH_SECRET: string }): LunoraAuthOptions => ({
    appName: APP_NAME,
    baseURL: "http://localhost:5173",
    emailAndPassword: {
        enabled: true,
        // Revoke other sessions when a user resets their password so a leaked
        // session can't outlive the reset.
        revokeSessionsOnPasswordReset: true,
        // Dev delivery: log the reset link. Replace with an `@lunora/mail` send
        // in production.
        sendResetPassword: async ({ url, user }) => {
            // eslint-disable-next-line no-console
            console.log(`[auth] password reset for ${user.email}: ${url}`);
        },
    },
    plugins: [
        organization({
            allowUserToCreateOrganization: true,
            // Dev delivery: log the invitation. Replace with an `@lunora/mail`
            // send (linking to your accept-invite page) in production.
            sendInvitationEmail: async (data) => {
                // eslint-disable-next-line no-console
                console.log(`[auth] org invite to ${data.email} for "${data.organization.name}" (invitation ${data.id})`);
            },
        }),
        admin({ defaultRole: "user" }),
        twoFactor({
            issuer: APP_NAME,
            otpOptions: {
                // Dev delivery: log the OTP. Replace with an `@lunora/mail` send
                // in production.
                sendOTP: async ({ otp, user }) => {
                    // eslint-disable-next-line no-console
                    console.log(`[auth] 2FA OTP for ${user.email}: ${otp}`);
                },
            },
        }),
    ],
    secret: env.AUTH_SECRET,
});

/**
 * Runtime auth instance, backed by `@lunora/auth`'s SQL adapter over D1.
 * `lunoraD1Adapter` wires the adapter explicitly so the better-auth Kysely
 * dynamic-import doesn't hang `pnpm dev` (see its doc comment).
 */
export const buildAuth = (env: { AUTH_SECRET: string; DB: unknown }): ReturnType<typeof createAuth> =>
    createAuth({ ...options(env), database: lunoraD1Adapter(env.DB as never) });

/**
 * Migration-only instance wired to raw D1 so `ensureMigrated`'s Kysely migrator
 * can create the tables the SQL adapter then reads/writes. Its `$context` is
 * never touched, so the dynamic-import hang above doesn't apply.
 */
export const buildMigrationAuth = (env: { AUTH_SECRET: string; DB: unknown }): ReturnType<typeof createAuth> =>
    createAuth({ ...options(env), database: env.DB as never });
