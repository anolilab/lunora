/**
 * Ambient stub for the `postgres` (postgres.js) driver so the `hyperdrive`
 * registry item type-checks standalone under `registry/tsconfig.json` — the
 * driver is an optional peer of `@lunora/hyperdrive` and is not installed in
 * this repo. The consumer installs the real `postgres` package (this item's
 * `registry.json` adds it) and its own types supersede this shim.
 *
 * Only the surface the item uses is declared: the factory, and the `.unsafe`
 * escape hatch `fromPostgresJs` calls (`PostgresJsLike` in `@lunora/hyperdrive`).
 */
declare module "postgres" {
    /** The postgres.js client, narrowed to the `PostgresJsLike` shape the adapter consumes. */
    export interface Sql {
        unsafe: (text: string, params?: ReadonlyArray<unknown>) => Promise<unknown>;
    }

    const postgres: (connectionString: string, options?: Record<string, unknown>) => Sql;

    export default postgres;
}
