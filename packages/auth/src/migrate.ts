import { getMigrations } from "better-auth/db/migration";

import type { CirrusAuth, CirrusAuthOptions } from "./create-auth.js";

/**
 * Single-flight cache of in-flight (and completed) migration runs, keyed by the
 * `options` reference. Storing the *promise* — rather than a post-completion
 * flag — closes a TOCTOU race: concurrent callers that arrive before the first
 * run resolves all await the same promise instead of each launching the DDL
 * runner. A rejected run is evicted (below) so a transient failure can retry.
 */
const migrating = new WeakMap<object, Promise<void>>();

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

    const inFlight = migrating.get(options);

    if (inFlight) {
        return inFlight;
    }

    const run = (async (): Promise<void> => {
        const { runMigrations } = await getMigrations(options);

        await runMigrations();
    })();

    // Record the promise synchronously (before the first await above resolves)
    // so concurrent callers single-flight onto this run. On failure, evict the
    // cached promise so the next call can retry instead of replaying the error.
    migrating.set(options, run);

    try {
        await run;
    } catch (error) {
        migrating.delete(options);

        throw error;
    }
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
