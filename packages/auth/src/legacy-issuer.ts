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
 * This is upstream's own prescription for SQLite, which is the only engine the two
 * automated paths (a Durable Object's storage, and D1) run on: SQLite has no
 * `ALTER COLUMN`, so the column cannot be made nullable in place, and rebuilding the table
 * to relax one constraint is far more invasive than dropping a column nothing reads.
 * Nothing is lost — the values were synthetic (`local:credential`,
 * `local:oauth:<provider>`), derived from `providerId`, which identifies an account again.
 *
 * ## Nothing here guesses
 *
 * This issues an **irreversible** `DROP COLUMN` against production data on an automatic
 * path, so every input is read from the live database or from better-auth's own resolved
 * schema. A heuristic that is merely usually right is not good enough:
 *
 * Whether the column is *ours to drop* is decided by better-auth's current schema rather
 * than by its name ({@link schemaDeclaresIssuer}), and which indexes block the drop is read
 * from `sqlite_master` rather than reconstructed ({@link indexesReferencingIssuer}).
 *
 * ## Deleting this module
 *
 * Transitional, like `d1-index-introspection.ts` and the DDL mirror in `do-schema.ts`, and
 * it states its trigger for the same reason they do. It goes once no supported database can
 * still carry the column: one minor release after the `@better-auth/core` floor moves past
 * 1.7.2 (`package.json` already peers `>=1.7.3`), by which point every app has had to
 * migrate through a version that ran this. Delete this file, its two call sites
 * (`auth-do.ts`'s `#ensureReady`, `migrate.ts`'s `dropLegacyIssuerColumn`), the `index.ts`
 * export, the `api-snapshots/auth.api.md` entry, and `__tests__/legacy-issuer*`.
 * @see https://www.better-auth.com/docs/guides/1-7-upgrade-guide
 */
import { quoteIdentifier } from "../../../shared/quote-identifier";

/**
 * The physical column name. Not resolved through better-auth's field map: 1.7.3 deleted
 * `issuer` from the account schema entirely, so there is no longer a `fields.issuer` entry
 * to read a rename off. The literal is what the three affected releases wrote.
 */
const ISSUER_COLUMN = "issuer";

/** Matches the column name as a whole word, so `issuerId` / `issuer_url` / `reissuer` do not. */
const ISSUER_WORD = new RegExp(String.raw`\b${ISSUER_COLUMN}\b`, "iu");

/**
 * Whether better-auth's **current** resolved schema declares an `issuer` column — in which
 * case the column belongs to the app and must never be dropped.
 *
 * An app can add one through `account.additionalFields`, which better-auth merges into the
 * account model. Without this gate the Durable Object path is worse than a one-time data
 * loss: it becomes a permanent loop, because `authDoColumnAdditions` re-adds every
 * declared-but-missing column on each cold start and the cleanup would drop it again
 * immediately, leaving better-auth's next insert to fail on
 * `table account has no column named issuer`.
 *
 * It also keeps the widened peer range honest: a later better-auth that reintroduces the
 * field switches this cleanup off by itself rather than fighting it.
 * @param accountColumns Physical column names better-auth's resolved account model declares.
 * @returns `true` when the column is part of the current schema, and so is not the reverted one.
 */
export const schemaDeclaresIssuer = (accountColumns: Iterable<string>): boolean => [...accountColumns].includes(ISSUER_COLUMN);

/**
 * The names of the indexes referencing the column, read from `sqlite_master` rows.
 *
 * Enumerated rather than derived. better-auth names an index after the **physical**
 * columns — `resolveDatabaseTableIndexes` maps each field through `field.fieldName` before
 * naming — so an app that renamed `accountId` got `account_issuer_<renamed>_uidx`, and a
 * name reconstructed from the default fields misses it. Enumerating also catches a second
 * index someone added by hand. Either miss is fatal rather than cosmetic: SQLite refuses
 * `DROP COLUMN` while any index still references the column.
 *
 * Matching the name inside *index* DDL is safe in a way that matching it inside *table* DDL
 * is not — this runs only once the column is confirmed present and un-declared, so an index
 * mentioning it is by definition an index on the reverted column. A `null` `sql` is
 * SQLite's own auto-index, which cannot reference it.
 * @param indexes `name` / `sql` rows for the account table's indexes.
 * @returns The names to drop, in the order given.
 */
export const indexesReferencingIssuer = (indexes: Iterable<{ name: string; sql?: null | string }>): string[] =>
    [...indexes].filter((index) => ISSUER_WORD.test(index.sql ?? "")).map((index) => index.name);

/**
 * The cleanup statements, in execution order: every blocking index, then the column.
 *
 * Exported for the pre-applied-schema path (`compileMigrationsSql` + `wrangler d1 execute`),
 * which compiles DDL without ever reading the database and so can neither tell whether the
 * column is present nor discover the index names — SQLite has no `DROP COLUMN IF EXISTS` to
 * make either unnecessary. Pass the names from
 * `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'account'`, and
 * run this only against a database that still has the column.
 * @param accountTable Physical name of the account table (`account` unless renamed via `account.modelName`).
 * @param indexNames Indexes to drop first, from {@link indexesReferencingIssuer}.
 * @returns The `DROP INDEX` statements followed by the `DROP COLUMN`.
 * @experimental
 */
export const legacyIssuerCleanupStatements = (accountTable = "account", indexNames: Iterable<string> = []): string[] => [
    ...[...indexNames].map((name) => `DROP INDEX IF EXISTS ${quoteIdentifier(name)}`),
    `ALTER TABLE ${quoteIdentifier(accountTable)} DROP COLUMN ${quoteIdentifier(ISSUER_COLUMN)}`,
];
