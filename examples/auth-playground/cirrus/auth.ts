import { createAuth } from "@cirrus/auth";
import { admin, organization } from "@cirrus/auth/plugins";

/**
 * App-wide auth instance. Better-auth's `database` field accepts a Cloudflare
 * D1 binding directly, so all we hand it is `env.DB`. The plugin list is what
 * gives this playground its admin panel and organization features:
 *
 * - `organization()` adds orgs, members, invitations + a slate of endpoints
 *   reachable through `auth.api.createOrganization` / `inviteMember` / …
 * - `admin()` adds the ban/impersonate surface; the first user we sign up
 *   below is promoted to `role: "admin"` via the seeded `adminUserIds` list.
 *
 * Polar billing is intentionally NOT included — if you need it, install
 * `@polar-sh/better-auth` and add `polar()` to the `plugins` array.
 */
export const buildAuth = (env: { AUTH_SECRET: string; DB: unknown }): ReturnType<typeof createAuth> =>
    createAuth({
        baseURL: "http://localhost:5173",
        // Better-auth accepts the D1 binding directly; no Kysely wiring needed.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        database: env.DB as any,
        emailAndPassword: { enabled: true },
        plugins: [organization({ allowUserToCreateOrganization: true }), admin({ defaultRole: "user" })],
        secret: env.AUTH_SECRET,
    });
