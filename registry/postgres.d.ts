/**
 * Ambient stub for the `postgres` (postgres.js) driver so the `hyperdrive`
 * registry item type-checks standalone under `registry/tsconfig.json` — the
 * driver is an optional peer of `@lunora/hyperdrive` and is not installed here.
 * The consumer installs the real `postgres` package (this item's `registry.json`
 * adds it) and its own types supersede this shim.
 *
 * It copies the REAL `unsafe` signature, and that is the point. This stub used
 * to declare `unsafe` as literally `PostgresJsLike` — the type it is handed to —
 * so the assignment it was meant to prove was true by construction. Real
 * postgres.js declares
 *
 *     unsafe<T extends any[] = …>(query: string, parameters?: ParameterOrJSON<…>[],
 *                                 queryOptions?: UnsafeQueryOptions): PendingQuery<T>
 *
 * — a MUTABLE parameter array, a third optional argument, and a thenable rather
 * than a bare `Promise`. Under an arrow-property `PostgresJsLike` none of that
 * assigns, so every consumer of the `hyperdrive` item got
 * `TS2345: Argument of type 'Sql<{}>' is not assignable to parameter of type
 * 'PostgresJsLike'` while this gate stayed silent. Keep the three differences
 * above: they are what makes the check mean anything.
 */
declare module "postgres" {
    /** Stands in for postgres.js's `ParameterOrJSON<T>` union — the element type is not what this stub is testing. */
    type Parameter = unknown;

    /** postgres.js resolves to a thenable query object, not a bare `Promise`. */
    type PendingQuery<T> = Promise<T> & { readonly execute: () => PendingQuery<T> };

    /** The postgres.js client, carrying the `unsafe` escape hatch `fromPostgresJs` consumes. */
    export interface Sql {
        unsafe<T = unknown>(query: string, parameters?: Parameter[], queryOptions?: Record<string, unknown>): PendingQuery<T>;
    }

    const postgres: (connectionString: string, options?: Record<string, unknown>) => Sql;

    export default postgres;
}
