import { getAuthTablesWithResolvedIndexes, invalidateSchemaChecks } from "@better-auth/core/db/internal";

import { quoteIdentifier } from "../../../shared/quote-identifier";
import { authCanonicalEmailColumn, backfillCanonicalEmails } from "./canonical-email";
import type { LunoraAuthOptions } from "./create-auth";
import { resolveAuthOptions } from "./create-auth";
import { convertAuthDatesOnce } from "./dates";
import { backfillInvitationEmails, invitationEmailColumns } from "./invitation-email-backfill";
import { indexesReferencingIssuer, legacyIssuerCleanupStatements, schemaDeclaresIssuer } from "./legacy-issuer";
import { executorDatabase, provisionOnce } from "./provision";
import type { SqlExecutor } from "./sql-store";

/**
 * Whether the account table physically carries the column.
 *
 * Probed with a zero-row `SELECT` rather than introspected. D1's authorizer refuses the
 * pragma table-valued functions a column list would come from (the reason
 * `d1-index-introspection.ts` exists), and the remaining option — pattern-matching
 * `sqlite_master.sql` — is not safe enough to gate an irreversible `DROP COLUMN`: SQLite
 * stores the verbatim `CREATE TABLE` text, so the name also appears in a comment, a
 * `CHECK (… <> 'issuer')` literal, or a `REFERENCES issuer(id)` clause. Matching any of
 * those would run a `DROP COLUMN` that fails with `no such column`, and because the DDL
 * text never changes the retry fails identically on every cold start, on a database that
 * was never broken. The probe answers the question exactly instead.
 *
 * The reference is **table-qualified**, and that is what makes the probe an answer rather
 * than a formality. workerd and D1 build SQLite with the double-quoted-string misfeature
 * enabled, so a bare `"issuer"` that resolves to no column is silently reinterpreted as a
 * string literal and the statement succeeds — the probe would report "present" for every
 * database on the only runtime this path runs on, and the cleanup would then fail its
 * `DROP COLUMN` and log a break that does not exist. A qualified name has no string-literal
 * reading, so it raises `no such column: t.issuer` on workerd, D1 and `node:sqlite` alike.
 * Verified in `__tests__/workerd/migrate-legacy-issuer.workerd.test.ts`; a Node-only suite
 * cannot see the difference, because `node:sqlite` builds with `SQLITE_DQS=0`.
 */
const hasIssuerColumn = async (executor: SqlExecutor, accountTable: string): Promise<boolean> => {
    const alias = quoteIdentifier("t");

    try {
        await executor.all(`SELECT ${alias}.${quoteIdentifier("issuer")} FROM ${quoteIdentifier(accountTable)} AS ${alias} LIMIT 0`, []);

        return true;
    } catch {
        // Either the column or the table is absent; both mean there is nothing to clean up.
        // This is also the direction the uncertainty must fall: a false "absent" skips a
        // cleanup, a false "present" runs an irreversible `DROP COLUMN`.
        return false;
    }
};

/**
 * Remove the `account.issuer` column better-auth 1.7.0 required and 1.7.3 reverted (see
 * `legacy-issuer.ts`): on a database provisioned under 1.7.0-1.7.2 every sign-up fails on
 * `NOT NULL constraint failed: account.issuer` until it is gone, and better-auth's migrator
 * does not touch it.
 *
 * **Best-effort**: a database that still carries the column is no worse off than before the
 * attempt, so it logs rather than throws. That also covers the concurrent case, where two
 * isolates both see the column and the loser's `DROP COLUMN` finds it already gone.
 * @returns Whether the column was dropped.
 */
const dropLegacyIssuerColumn = async (executor: SqlExecutor, options: LunoraAuthOptions): Promise<boolean> => {
    const { account } = getAuthTablesWithResolvedIndexes(options).tables;

    // The app's own column, added through `account.additionalFields`, is not the reverted one and must survive.
    if (account === undefined || schemaDeclaresIssuer(Object.entries(account.fields).map(([key, field]) => field.fieldName ?? key))) {
        return false;
    }

    if (!(await hasIssuerColumn(executor, account.modelName))) {
        return false;
    }

    if (executor.batch === undefined) {
        // eslint-disable-next-line no-console -- no injected logger at this layer (workerd/Node both capture console)
        console.error(
            "@lunora/auth: the reverted `account.issuer` column is present, but this executor has no `batch`, so it cannot be dropped atomically with its indexes; sign-ups fail until it is removed (`legacyIssuerCleanupStatements()`).",
        );

        return false;
    }

    try {
        // Enumerated rather than derived from the default field names: better-auth names an index
        // after the physical columns, and any index still referencing `issuer` makes the
        // `DROP COLUMN` fail. `sqlite_master` is readable through D1; the pragma index functions are not.
        const indexes = await executor.all("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?", [account.modelName]);

        // One batch, so the indexes cannot be dropped without the column following: SQLite has no
        // way back to a unique index that is gone while the column it covered stays.
        await executor.batch(
            legacyIssuerCleanupStatements(account.modelName, indexesReferencingIssuer(indexes as { name: string; sql?: null | string }[])).map((sql) => {
                return { params: [], sql };
            }),
        );

        return true;
    } catch (error) {
        // eslint-disable-next-line no-console -- no injected logger at this layer (workerd/Node both capture console)
        console.error(
            "@lunora/auth: could not drop the reverted `account.issuer` column; if it is still present, sign-ups will fail until it is removed.",
            error,
        );

        return false;
    }
};

/** The `options` whose issuer cleanup has run in this isolate, whatever its outcome. */
const issuerChecked = new WeakMap<object, Promise<void>>();

/**
 * Run {@link dropLegacyIssuerColumn} once per isolate per `options`; concurrent callers share the attempt.
 *
 * A drop also re-takes the adapter's schema verdict, which was taken while the required `issuer` column
 * was still there. better-auth keys it on the D1 binding the executor wraps. Inside the memoised run, so
 * it happens once rather than on every later call, each of which would re-introspect every auth table.
 */
const dropLegacyIssuerOnce = async (key: object, executor: SqlExecutor, options: LunoraAuthOptions): Promise<void> => {
    let run = issuerChecked.get(key);

    if (run === undefined) {
        run = dropLegacyIssuerColumn(executor, options).then((dropped) => {
            const database = executorDatabase(executor);

            if (dropped && database !== undefined) {
                invalidateSchemaChecks(database);
            }

            return undefined;
        });
        issuerChecked.set(key, run);
    }

    await run;
};

/** The backfill pass in flight per `options`, so concurrent callers share one rather than racing over the same rows. */
const backfilling = new WeakMap<object, Promise<void>>();

/** The `options` whose backfills have reached the end of their tables; later calls skip them. */
const backfilled = new WeakSet<object>();

/**
 * One pass of the canonical-email and invitation-email backfills, never rejecting: a pass that
 * fails, or stops at D1's query limit, has saved its position, and until the backfill is done the
 * duplicate checks fold the rows it has not reached, so the request it runs in must not fail for it.
 *
 * `fill` resolves whether every backfill reached the end of its table.
 */
const backfillPass = async (key: object, fill: () => Promise<boolean>): Promise<void> => {
    if (backfilled.has(key)) {
        return;
    }

    let run = backfilling.get(key);

    if (run === undefined) {
        run = fill()
            .then(
                (complete) => {
                    if (complete) {
                        backfilled.add(key);
                    }

                    return undefined;
                },
                (error: unknown) => {
                    // eslint-disable-next-line no-console -- no injected logger at this layer (workerd/Node both capture console)
                    console.error("@lunora/auth: the canonical-email backfill stopped; the next call resumes it.", error);
                },
            )
            .finally(() => backfilling.delete(key));
        backfilling.set(key, run);
    }

    await run;
};

/**
 * Fill `user.emailCanonical` on rows that predate the column, and rewrite `signUpInvitation.email`
 * to the same canonical form. The value needs Unicode lowercasing SQLite does not have, so it is
 * computed here rather than in DDL. A bounded number of pages each, sharing the invocation's D1
 * query limit; the position is kept in the database, so the next call resumes.
 */
const backfillThroughExecutor = async (executor: SqlExecutor, options: LunoraAuthOptions): Promise<boolean> => {
    const column = authCanonicalEmailColumn(options);
    const invitations = invitationEmailColumns(options);
    const users = column === undefined ? undefined : await backfillCanonicalEmails(executor, column);
    const invited = invitations === undefined ? undefined : await backfillInvitationEmails(executor, invitations);

    return (users?.complete ?? true) && (invited?.complete ?? true);
};

/** The date conversion in flight per `options`, so a concurrent caller waits for it rather than passing it. */
const convertingDates = new WeakMap<object, Promise<void>>();

/** The `options` whose date conversion has run in this isolate, successfully or not. */
const datesAttempted = new WeakSet<object>();

/**
 * Rewrite the ISO-string dates earlier versions stored as epoch ms (see `convertAuthDatesOnce`).
 *
 * Once per isolate, whatever the outcome: a worker that awaits this ahead of every route must not
 * pay a retry per request for a value that cannot be converted. It is logged, the rows still read
 * correctly, and the next cold start tries again.
 */
const convertDatesPass = async (key: object, executor: SqlExecutor, options: LunoraAuthOptions): Promise<void> => {
    if (datesAttempted.has(key)) {
        return;
    }

    let run = convertingDates.get(key);

    if (run === undefined) {
        run = convertAuthDatesOnce(executor, options)
            .then(
                () => undefined,
                (error: unknown) => {
                    // eslint-disable-next-line no-console -- no injected logger at this layer (workerd/Node both capture console)
                    console.error("@lunora/auth: converting stored ISO dates to epoch ms stopped; the next cold start retries it.", error);
                },
            )
            .finally(() => {
                datesAttempted.add(key);
                convertingDates.delete(key);
            });
        convertingDates.set(key, run);
    }

    await run;
};

/**
 * The data steps over an executor, memoised on `key`. `ensureMigrated` keys them on the options it
 * was given, so a later `prepareAuthData` with the same object finds them done.
 */
const prepareAuthDataFor = async (key: object, executor: SqlExecutor, options: LunoraAuthOptions): Promise<void> => {
    await dropLegacyIssuerOnce(key, executor, options);
    await backfillPass(key, async () => backfillThroughExecutor(executor, options));
    await convertDatesPass(key, executor, options);
};

/** What {@link prepareAuthData} may do before the data steps. */
interface PrepareAuthDataOptions {
    /**
     * Create the auth tables if they are missing, before anything reads them: for an app whose auth
     * tables are `.global()` tables in its Lunora schema, `(executor) => runD1GlobalTableMigrations(executor, schema)`.
     * Shared with `lunoraD1Adapter(db, { provision })` over the same binding, so it runs once per isolate across both.
     */
    provision?: (executor: SqlExecutor) => Promise<void>;
}

/**
 * Lunora's data steps for the auth tables, without better-auth's schema migrator: the
 * `account.issuer` cleanup, the canonical-email and invitation-email backfills, and the
 * ISO-date → epoch-ms conversion that keeps converting for a day after the first clean run
 * (so ISO dates written by isolates still on an older version during a rollout are caught).
 *
 * **Which to call.** `ensureMigrated` runs better-auth's migrator and then exactly these steps;
 * it needs a `database` the migrator can drive (a raw D1 binding) and throws
 * `AUTH_MIGRATOR_UNSUPPORTED` for an adapter. When the auth tables come from somewhere else —
 * `authTables(options)` declared `.global()` in the app's Lunora schema, served through
 * `lunoraD1Adapter` from the app's own Worker entry — call this instead, with the executor over
 * the same D1 binding, before building the auth instance (so a schema verdict the adapter takes
 * sees the cleaned-up `account` table).
 *
 * Never rejects for a data step: each logs and resumes on a later call or cold start, like
 * `ensureMigrated`. Memoised per `options` object for the isolate: the cleanup and conversion run
 * once, the backfill until it reaches the end of its tables. Pass the same long-lived options
 * object on every call; a fresh one per request repeats the work.
 *
 * ```ts
 * await prepareAuthData(d1Executor(env.DB), authOptions, { provision: (exec) => runD1GlobalTableMigrations(exec, schema) });
 * ```
 */
const prepareAuthData = async (executor: SqlExecutor, options: LunoraAuthOptions, settings: PrepareAuthDataOptions = {}): Promise<void> => {
    if (settings.provision !== undefined) {
        await provisionOnce(executor, settings.provision);
    }

    await prepareAuthDataFor(options, executor, resolveAuthOptions(options));
};

export type { PrepareAuthDataOptions };
export { backfillPass, dropLegacyIssuerOnce, prepareAuthData, prepareAuthDataFor };
