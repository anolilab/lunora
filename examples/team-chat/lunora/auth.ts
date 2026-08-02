import type { LunoraAuthOptions } from "@lunora/auth";

/**
 * Email + password only — this example is about chat, not about auth. See
 * `examples/auth-playground` for OAuth, organizations, admin, and 2FA.
 *
 * Only the options are exported: the worker entry owns building the instance,
 * running the migration sweep, and dispatching `/api/auth/*`.
 *
 * `baseURL` is deliberately absent.
 *
 * `@lunora/auth` derives its production posture from it: an explicit
 * `http://…` origin marks the deployment as local, which turns OFF
 * `useSecureCookies` and downgrades the weak-secret guard to a warning. Since
 * this example ships a one-click deploy button, hard-coding the dev origin here
 * would ship session cookies without `Secure` over HTTPS and let the sample
 * secret through. Left unset, the handler resolves the origin from the request,
 * which is correct in dev and in production. Set `AUTH_URL` and pass it here if
 * you need to pin one.
 */
export const authOptions = (env: { AUTH_SECRET: string }): LunoraAuthOptions => ({
    appName: "Lunora Team Chat",
    emailAndPassword: {
        enabled: true,
        revokeSessionsOnPasswordReset: true,
    },
    secret: env.AUTH_SECRET,
});
