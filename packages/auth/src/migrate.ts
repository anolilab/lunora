import { invalidateSchemaChecks } from "@better-auth/core/db/internal";
import { LunoraError } from "@lunora/errors";
import { betterAuth } from "better-auth";
import { getAdapter } from "better-auth/db/adapter";
import { getMigrations } from "better-auth/db/migration";

import { backfillPass, dropLegacyIssuerOnce, prepareAuthDataFor } from "./auth-data";
import { authCanonicalEmailColumn, backfillCanonicalEmailsThroughAdapter, warnDuplicates } from "./canonical-email";
import type { LunoraAuth, LunoraAuthOptions } from "./create-auth";
import { prepareAuthOptions, resolveAuthOptions } from "./create-auth";
import { isD1Database, withD1IndexIntrospection } from "./d1-index-introspection";
import { backfillInvitationEmailsThroughAdapter, invitationEmailColumns } from "./invitation-email-backfill";
import { d1Executor } from "./sql-store";

/**
 * Reject a `database` better-auth's migrator cannot drive, *before* handing it
 * over. better-auth only migrates through Kysely, and its own guard does not
 * throw — it calls `process.exit(1)`, which in a Workers isolate kills the whole
 * worker (every route, not just `/api/auth/*`) after a single 500.
 *
 * Two shapes reach that guard, and both are things people actually write. An
 * **adapter factory** (`lunoraD1Adapter` / `lunoraAuthAdapter` /
 * `lunoraDoAdapter`, or any other better-auth adapter) is a function, never a
 * Kysely dialect or database. And **nothing at all** (`database: undefined`) —
 * which `createKyselyAdapter` answers with `{ kysely: null }` exactly like an
 * adapter does, verified against better-auth 1.7.1.
 *
 * Anything else — a raw D1 binding, a dialect, a `{ db }` / `{ dialect }` pair —
 * is left for better-auth to resolve, which is the only place that knows the
 * full list.
 */
const assertMigratableDatabase = (options: LunoraAuthOptions): void => {
    // Widened to `unknown`: better-auth types `database` as a union whose adapter
    // arm the linter reads as an error type, so destructuring it as-is trips
    // `no-unsafe-assignment`. All this guard needs is truthy-and-not-a-function.
    const { database } = options as { database?: unknown };

    if (database && typeof database !== "function") {
        return;
    }

    throw new LunoraError(
        "AUTH_MIGRATOR_UNSUPPORTED",
        database
            ? "@lunora/auth: this auth instance's `database` is a custom adapter, which better-auth's migrator cannot drive."
            : "@lunora/auth: this auth instance has no `database`, so better-auth's migrator has nothing to introspect.",
    );
};

/**
 * Swap a D1 binding for one that can answer better-auth's index introspection.
 *
 * Only the migration path needs this — `getDatabaseIndexes()` runs inside
 * `getMigrations()` — so request-time queries keep the untouched binding. See
 * `d1-index-introspection.ts` for why D1 rejects the upstream query.
 */
const withD1MigrationSupport = (options: LunoraAuthOptions): LunoraAuthOptions =>
    isD1Database(options.database) ? { ...options, database: withD1IndexIntrospection(options.database) } : options;

/**
 * The canonical-email and invitation-email backfills for a database that is not D1, through
 * better-auth's adapter, which has no per-invocation query limit, so each runs to the end of its
 * table. D1 goes through `prepareAuthData`'s SQL path instead.
 */
const backfillThroughAdapter = async (options: LunoraAuthOptions): Promise<boolean> => {
    const column = authCanonicalEmailColumn(options);
    const adapter = await getAdapter(options);

    if (column !== undefined) {
        const { duplicates, rows } = await backfillCanonicalEmailsThroughAdapter(adapter);

        warnDuplicates(duplicates, column, rows);
    }

    if (invitationEmailColumns(options) !== undefined) {
        await backfillInvitationEmailsThroughAdapter(adapter);
    }

    return true;
};

/**
 * Bump this database's schema revision, so a schema verdict `lunoraD1Adapter`'s
 * check cached before the migration is re-taken rather than replayed.
 *
 * better-auth keys the revision on the database **object**, and the two instances
 * agree on it by construction: the request instance registers its check against
 * the binding handed to `lunoraD1Adapter(env.DB)`, and this migration instance
 * holds that same `env.DB` as its `database` (the migrator needs the raw binding —
 * see {@link assertMigratableDatabase}). Without this, a mismatch observed before
 * the migration ran would be rethrown for the life of the isolate even though the
 * migration has just fixed it.
 *
 * Reads `options.database`, not the proxy {@link withD1MigrationSupport} builds:
 * that is a different object and would invalidate nothing. Widened to `unknown`
 * for the same reason {@link assertMigratableDatabase} does it — better-auth's
 * `database` union has an adapter arm the linter reads as an error type. The type
 * guard is narrowing, not doubt: `assertMigratableDatabase` has already rejected a
 * falsy or function `database` by the time this runs.
 */
const invalidateAuthSchemaChecks = (options: LunoraAuthOptions): void => {
    const { database } = options as { database?: unknown };

    if (typeof database === "object" && database !== null) {
        invalidateSchemaChecks(database);
    }
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
 * Then Lunora's data steps, the same ones `prepareAuthData` runs without the migrator: on D1, the
 * reverted `account.issuer` cleanup, the canonical-email and invitation-email backfills (a bounded
 * number of pages per call, resumed by the next) and the ISO-date conversion (`convertAuthDatesOnce`);
 * on any other database, the backfills through better-auth's adapter. None of them rejects the call.
 *
 * Use this when better-auth's migrator owns the auth tables. When they are declared in the app's
 * Lunora schema (`authTables(options)` as `.global()` tables) the migrator cannot run over the
 * adapter — this throws `AUTH_MIGRATOR_UNSUPPORTED` for one — so call `prepareAuthData` instead.
 *
 * For production you should prefer pre-applying the schema at deploy time
 * via `compileMigrationsSql` + `wrangler d1 execute`; this helper exists for
 * dev/playground and small deployments.
 */
export const ensureMigrated = async (auth: LunoraAuth | { options: LunoraAuthOptions }): Promise<void> => {
    const { options: given } = auth;

    assertMigratableDatabase(given);

    // The columns `resolveAuthOptions` declares (`user.emailCanonical`, the rate-limit table) are what
    // `createAuth` writes, so raw options passed as `{ options }` migrate the same schema an instance has.
    // Idempotent on an instance's options, which are resolved already.
    const options = resolveAuthOptions(given);
    let run = migrating.get(given);

    if (run === undefined) {
        run = (async (): Promise<void> => {
            const { runMigrations } = await getMigrations(withD1MigrationSupport(options));

            await runMigrations();

            // Ahead of the invalidation: a verdict re-taken while the required `issuer` column is
            // still there would cache a mismatch for the isolate.
            if (isD1Database(options.database)) {
                await dropLegacyIssuerOnce(given, d1Executor(options.database), options);
            }

            invalidateAuthSchemaChecks(options);
        })();
        // Record the promise synchronously so concurrent callers single-flight onto this run. On failure,
        // evict it so the next call can retry instead of replaying the error.
        migrating.set(given, run);
        run.catch(() => migrating.delete(given));
    }

    await run;

    await (isD1Database(options.database)
        ? prepareAuthDataFor(given, d1Executor(options.database), options)
        : backfillPass(given, async () => backfillThroughAdapter(options)));
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
 *
 * **Upgrading a database created by an older `@lunora/auth`.** This compiles DDL without
 * reading the database, so it cannot know whether the `account.issuer` column better-auth
 * 1.7.0 required and 1.7.3 reverted is present — and SQLite has no `DROP COLUMN IF EXISTS`
 * to make that moot. `ensureMigrated` and `prepareAuthData` handle it automatically; on this
 * path, run `legacyIssuerCleanupStatements()` once against a database that still has the column.
 * Leaving it in place fails every sign-up with `NOT NULL constraint failed: account.issuer`.
 *
 * The same goes for `user.emailCanonical`: the compiled DDL adds the column, but filling it
 * on existing rows needs Unicode lowercasing SQLite lacks, so `ensureMigrated` (which the
 * generated worker runs on its first auth request) or `prepareAuthData` does it. Until then the duplicate-address
 * checks (the admin plane's, and the user create/update hook every sign-up and email change goes
 * through) fold the addresses of the rows still unfilled themselves, so they hold.
 */
export const compileMigrationsSql = async (options: LunoraAuthOptions): Promise<string> => {
    const resolved = resolveAuthOptions(options);

    assertMigratableDatabase(resolved);

    const { compileMigrations } = await getMigrations(withD1MigrationSupport(resolved));

    return compileMigrations();
};

/**
 * The migration-only auth instance: the same validated, hardened options as `createAuth`, but
 * through the full `better-auth` entry so `database` may be the raw D1 binding the Kysely
 * migrator drives. Hand it to {@link ensureMigrated}; never serve requests from it. Lives here
 * so the migrator's Kysely edge stays out of the runtime bundle.
 */
export const createMigrationAuth = (options: LunoraAuthOptions): LunoraAuth => betterAuth(prepareAuthOptions(options));
