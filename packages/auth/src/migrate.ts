import { LunoraError } from "@lunora/errors";
import { getMigrations } from "better-auth/db/migration";

import type { LunoraAuth, LunoraAuthOptions } from "./create-auth";
import { resolveAuthOptions } from "./create-auth";
import { isD1Database, withD1IndexIntrospection } from "./d1-index-introspection";

/**
 * Reject a `database` better-auth's migrator cannot drive, *before* handing it
 * over. better-auth only migrates through Kysely, and its own guard does not
 * throw — it calls `process.exit(1)`, which in a Workers isolate kills the whole
 * worker (every route, not just `/api/auth/*`) after a single 500. An adapter
 * factory — `lunoraAuthAdapter` / `lunoraD1Adapter` / `lunoraDoAdapter`, or any
 * other better-auth adapter — is exactly that case: it is a function, never a
 * Kysely dialect/database.
 */
const assertMigratableDatabase = (options: LunoraAuthOptions): void => {
    if (typeof options.database !== "function") {
        return;
    }

    throw new LunoraError(
        "INTERNAL",
        "@lunora/auth: better-auth can only migrate through its Kysely adapter, and this auth instance " +
            "uses a custom adapter (`lunoraAuthAdapter`/`lunoraD1Adapter`/`lunoraDoAdapter`). " +
            "Provision the schema instead: declare the auth tables in `lunora/schema.ts` as `.global()` " +
            "tables (Lunora creates them for you), or apply better-auth's own DDL at deploy time with " +
            "`compileMigrationsSql` + `wrangler d1 execute`. Passing the raw D1 binding as `database` also " +
            "works for the migration instance only.",
    );
};

/**
 * Swap a D1 binding for one that can answer better-auth's index introspection.
 *
 * Only the migration path needs this — `getDatabaseIndexes()` runs inside
 * `getMigrations()` — so request-time queries keep the untouched binding. See
 * `d1-index-introspection.ts` for why D1 rejects the upstream query.
 *
 * Both `getMigrations()` callers route through here, so it is also the one place
 * {@link assertMigratableDatabase} has to run.
 */
const withD1MigrationSupport = (options: LunoraAuthOptions): LunoraAuthOptions => {
    assertMigratableDatabase(options);

    return isD1Database(options.database) ? { ...options, database: withD1IndexIntrospection(options.database) } : options;
};

/**
 * Single-flight cache of in-flight (and completed) migration runs, keyed by the
 * `options` reference. Storing the *promise* — rather than a post-completion
 * flag — closes a TOCTOU race: concurrent callers that arrive before the first
 * run resolves all await the same promise instead of each launching the DDL
 * runner. A rejected run is evicted (below) so a transient failure can retry.
 *
 * INVARIANT: the cache is keyed by *object identity*, not value. Two distinct
 * `options` objects targeting the same DB do NOT share an entry — so this only
 * deduplicates when the SAME long-lived options object is reused (the Workers
 * isolate-reuse case). A caller that builds `createAuth({...})` per request
 * gets a fresh options reference every time and the diff re-runs on each call.
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
export const ensureMigrated = async (auth: LunoraAuth | { options: LunoraAuthOptions }): Promise<void> => {
    const { options } = auth;

    const inFlight = migrating.get(options);

    if (inFlight) {
        await inFlight;

        return;
    }

    const run = (async (): Promise<void> => {
        const { runMigrations } = await getMigrations(withD1MigrationSupport(options));

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
 *
 * Compiles from the SAME resolved options `createAuth` runs with (via
 * `resolveAuthOptions`), not the raw caller options — so the schema includes the
 * `rateLimit` table the worker's default-on durable limiter writes to. Compiling
 * from the raw options would omit it, and the running worker would then write to
 * a table the migration never created.
 */
export const compileMigrationsSql = async (options: LunoraAuthOptions): Promise<string> => {
    const { compileMigrations } = await getMigrations(withD1MigrationSupport(resolveAuthOptions(options)));

    return compileMigrations();
};
