/**
 * The optimistic-concurrency row version every global table carries alongside
 * `id`/`_creationTime`.
 *
 * The CAS used to bind one parameter per physical column of the snapshot, so an
 * `UPDATE` on a wide table bound `2N+2` parameters — over D1's 100-per-statement
 * ceiling (workerd's `SQLITE_LIMIT_VARIABLE_NUMBER`) from 50 declared fields up,
 * while `INSERT` at the same width stayed under it. The table provisioned, rows
 * inserted, and the first `patch`/`replace`/soft-`delete` died with a raw
 * `too many SQL variables` that redacts to "Internal error" on the way out.
 *
 * Guarding on this one column instead makes the CAS cost two parameters at any
 * width. Every guarded write bumps it in SQL (`COALESCE(<col>, 0) + 1`), which
 * costs no parameter of its own; `INSERT` leaves it NULL, and the NULL-safe
 * comparison handles both that and rows written before the column existed.
 *
 * Not decoded into documents — `decodeGlobalRow` builds its result from the
 * declared shape, so an undeclared physical column is invisible to callers.
 *
 * Bundler-inlined rather than owned by one package because BOTH producers of
 * global-table DDL name it: `@lunora/sql-store`'s auto-provisioner (which runs
 * the CAS) and `@lunora/d1/dialect`, which `lunora migrate generate` derives its
 * `CREATE TABLE` from. Importing `@lunora/sql-store` would pull drizzle into the
 * dependency-free dialect module the CLI reads; a second copy of the string is
 * how the two shapes drift.
 */
export const OCC_VERSION_COLUMN = "_version";
