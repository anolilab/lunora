/**
 * Cleanup for the `account.issuer` column better-auth added in 1.7.0 and reverted in 1.7.3.
 *
 * ## What happened upstream
 *
 * 1.7.0 re-keyed an account from `(providerId, accountId)` to `(issuer, accountId)`,
 * adding a **required** `issuer` column and a unique index over the pair. 1.7.3 reverted
 * all of it (better-auth/better-auth#11153) because the change broke sign-in for existing
 * 1.6 databases and needed a backfill to migrate — upstream judged that "backfilling
 * existing accounts and adding a NOT NULL constraint introduces significant operational
 * risk for production services", and committed to keeping the core schema stable for the
 * rest of v1.
 *
 * ## Why a database can be left broken
 *
 * The revert only stopped better-auth *writing* `issuer`; it does not touch a schema that
 * already has the column, and upstream's own migrator explicitly does not either. So a
 * database provisioned while 1.7.0-1.7.2 was installed still carries
 * `issuer text NOT NULL`, and every insert 1.7.3 makes omits it — which means **every
 * sign-up and account link fails** on a `NOT NULL constraint failed: account.issuer`
 * until the constraint is gone. That is a live break, not a latent one.
 *
 * ## Why the column is dropped rather than relaxed
 *
 * This is upstream's own prescription for SQLite, which is the only engine these two
 * paths (a Durable Object's storage, and D1) run on: SQLite has no `ALTER COLUMN`, so the
 * column cannot be made nullable in place, and rebuilding the table to relax one
 * constraint is far more invasive than dropping a column nothing reads. Nothing is lost —
 * the values were synthetic (`local:credential`, `local:oauth:<provider>`), derived from
 * `providerId`, and 1.7.3 keys accounts by `providerId` again.
 *
 * The index is dropped **first**: SQLite refuses `DROP COLUMN` on an indexed column.
 * @see https://www.better-auth.com/docs/guides/1-7-upgrade-guide
 */
import { getDatabaseIndexName } from "@better-auth/core/db/internal";

import { quoteIdentifier } from "../../../shared/quote-identifier";

/**
 * The physical column name. Not resolved through better-auth's field map: 1.7.3 deleted
 * `issuer` from the account schema entirely, so there is no longer a `fields.issuer` entry
 * to read a rename off. The literal is what the three affected releases wrote by default.
 */
const ISSUER_COLUMN = "issuer";

/**
 * The unique index 1.7.0-1.7.2 created over `(issuer, accountId)`, named the way
 * better-auth itself named it — derived from its own helper rather than hard-coded, so
 * this drops the index that was actually created rather than one that merely looks right.
 */
const legacyIssuerIndexName = (accountTable: string): string => getDatabaseIndexName(accountTable, { fields: [ISSUER_COLUMN, "accountId"], unique: true });

/**
 * The statements that remove the reverted column, in execution order.
 *
 * Exported so an operator on the pre-applied-schema path (`compileMigrationsSql` +
 * `wrangler d1 execute`) can run the same SQL the automatic paths run. That path compiles
 * DDL without ever reading the database, so it cannot decide for itself whether the column
 * is there — and SQLite has no `DROP COLUMN IF EXISTS` to make the decision unnecessary.
 * Run these only against a database that has the column; `DROP COLUMN` errors when it does
 * not.
 * @param accountTable Physical name of the account table (`account` unless renamed via `account.modelName`).
 * @returns The `DROP INDEX` and `DROP COLUMN` statements, index first.
 * @experimental
 */
export const legacyIssuerCleanupStatements = (accountTable = "account"): string[] => [
    `DROP INDEX IF EXISTS ${quoteIdentifier(legacyIssuerIndexName(accountTable))}`,
    `ALTER TABLE ${quoteIdentifier(accountTable)} DROP COLUMN ${quoteIdentifier(ISSUER_COLUMN)}`,
];

/**
 * Whether a list of existing physical columns still carries the reverted column.
 *
 * Takes an array rather than an `Iterable<string>` on purpose: a `string` satisfies
 * `Iterable<string>` by iterating its *characters*, so the DDL-text caller below could
 * have been passed here and silently answered `false` for every database.
 * @param existingColumns The account table's current columns; empty when the table is absent.
 * @returns `true` when the cleanup statements should run.
 */
export const hasLegacyIssuerColumn = (existingColumns: ReadonlyArray<string>): boolean => existingColumns.includes(ISSUER_COLUMN);

/**
 * Whether a `CREATE TABLE` statement declares the reverted column.
 *
 * For callers that can only read `sqlite_master.sql` — D1 through a Worker binding, whose
 * authorizer refuses the pragma table-valued functions a column list would otherwise come
 * from. Matched on a word boundary, so a distinct column that merely contains the same
 * letters (`issuerId`, `issuer_url`, `reissuer`) does not trigger a destructive drop —
 * `_` is a word character, which is what makes `issuer_url` a non-match.
 * @param createTableSql The table's DDL as stored by SQLite; `""` when the table is absent.
 * @returns `true` when the cleanup statements should run.
 */
export const ddlDeclaresLegacyIssuer = (createTableSql: string): boolean => new RegExp(String.raw`\b${ISSUER_COLUMN}\b`, "iu").test(createTableSql);
