import type { CirrusAuthOptions } from "@cirrus/auth";
import { cirrusAuthAdapter, createAuth, createSqlAuthStore, d1Executor } from "@cirrus/auth";
import { admin, organization } from "@cirrus/auth/plugins";

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
const options = (env: { AUTH_SECRET: string }): CirrusAuthOptions => ({
    baseURL: "http://localhost:5173",
    emailAndPassword: { enabled: true },
    plugins: [organization({ allowUserToCreateOrganization: true }), admin({ defaultRole: "user" })],
    secret: env.AUTH_SECRET,
});

/**
 * Runtime auth instance, backed by `@cirrus/auth`'s SQL adapter over D1.
 *
 * We pass an explicit adapter rather than the raw `env.DB`: with raw D1,
 * better-auth resolves its Kysely adapter via a runtime `await import(...)`
 * inside `auth.$context`, which never settles under `@cloudflare/vite-plugin`'s
 * worker module runner — hanging every auth request in `pnpm dev`. An explicit
 * adapter skips that import, so dev and a deployed worker behave the same.
 */
export const buildAuth = (env: { AUTH_SECRET: string; DB: unknown }): ReturnType<typeof createAuth> =>
    createAuth({ ...options(env), database: cirrusAuthAdapter(createSqlAuthStore(d1Executor(env.DB as never))) });

/**
 * Migration-only instance wired to raw D1 so `ensureMigrated`'s Kysely migrator
 * can create the tables the SQL adapter then reads/writes. Its `$context` is
 * never touched, so the dynamic-import hang above doesn't apply.
 */
export const buildMigrationAuth = (env: { AUTH_SECRET: string; DB: unknown }): ReturnType<typeof createAuth> =>
    createAuth({ ...options(env), database: env.DB as never });
