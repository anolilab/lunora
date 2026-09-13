/**
 * Columns Lunora's own table machinery puts on a table and better-auth knows
 * nothing about.
 *
 * Its own module because two modules on different tiers need the same name and
 * neither should own it: `sql-store.ts` fills the column on every insert, and
 * `schema-check.ts` has to tell better-auth's schema diff that an insert omitting
 * it still succeeds. Declaring it in `sql-store.ts` would either duplicate the
 * literal or widen the public `@lunora/auth/sql-store` surface with an internal
 * constant; declaring it in `schema-check.ts` would make the low-level store
 * import from the check that sits above it.
 *
 * Deliberately NOT in the package's `exports` map: internal to `@lunora/auth`.
 */

/**
 * The creation timestamp `defineTable` puts on every Lunora table — `REAL NOT
 * NULL`, with no DDL default, on both the D1 auto-provisioner's output and
 * `lunora migrate`'s.
 */
// Sole export, so it is the file's default (the repo forbids mixing a default with
// named exports, and ESLint requires one on a single-export file).
export default "_creationTime";
