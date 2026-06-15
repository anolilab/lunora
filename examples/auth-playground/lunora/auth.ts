import type { LunoraAuthOptions } from "@lunora/auth";
import { lunoraD1Adapter, createAuth } from "@lunora/auth";
import { admin, organization } from "@lunora/auth/plugins";

/**
 * Auth config shared by the runtime and migration instances. The plugin list is
 * what gives this playground its admin panel and organization features:
 *
 * - `organization()` adds orgs, members, invitations + a slate of endpoints
 *   reachable through `auth.api.createOrganization` / `inviteMember` / …
 * - `admin()` adds the ban/impersonate surface; the first user we sign up
 *   below is promoted to `role: "admin"` via the seeded `adminUserIds` list.
 *
 * Polar billing is intentionally NOT included — if you need it, install
 * `@polar-sh/better-auth` and add `polar()` to the `plugins` array.
 */
const options = (env: { AUTH_SECRET: string }): LunoraAuthOptions => ({
    baseURL: "http://localhost:5173",
    emailAndPassword: { enabled: true },
    plugins: [organization({ allowUserToCreateOrganization: true }), admin({ defaultRole: "user" })],
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
