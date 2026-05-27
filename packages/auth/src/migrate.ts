import { getMigrations } from "better-auth/db/migration";

import type { CirrusAuth, CirrusAuthOptions } from "./create-auth.js";

const migrated = new WeakSet<object>();

/**
 * Apply better-auth's required schema (`user`, `session`, `account`,
 * `verification`) to the configured database. Idempotent — better-auth
 * diffs the existing schema and only runs the missing DDL.
 *
 * Cached per `options` reference so the diff cost (one PRAGMA-style sweep
 * per table) doesn't fire on every request. In Cloudflare Workers the same
 * `env.DB` binding is reused across invocations within a single isolate, so
 * caching against the options object — which captures the binding — is
 * sufficient.
 *
 * For production you should prefer pre-applying the schema at deploy time
 * via `compileMigrationsSql` + `wrangler d1 execute`; this helper exists for
 * dev/playground and small deployments.
 */
export const ensureMigrated = async (auth: CirrusAuth | { options: CirrusAuthOptions }): Promise<void> => {
    const { options } = auth;

    if (migrated.has(options)) {
        return;
    }

    const { runMigrations } = await getMigrations(options);

    await runMigrations();

    migrated.add(options);
};

/**
 * Compile better-auth's migrations to a single SQL string. Useful for
 * `wrangler d1 execute --file -` in CI so the deploy step applies the schema
 * before the first user request.
 */
export const compileMigrationsSql = async (options: CirrusAuthOptions): Promise<string> => {
    const { compileMigrations } = await getMigrations(options);

    return compileMigrations();
};
