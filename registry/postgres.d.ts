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
 *     unsafe<T extends any[] = (Row & Iterable<Row>)[]>(
 *         query: string,
 *         parameters?: ParameterOrJSON<…>[],
 *         queryOptions?: UnsafeQueryOptions): PendingQuery<T>
 *
 * — a CONSTRAINED and defaulted type parameter, a MUTABLE parameter array, a
 * third optional argument, and a thenable that resolves to `RowList<T>` rather
 * than a bare `Promise<T>`. Under an arrow-property `PostgresJsLike` none of
 * that assigns, so every consumer of the `hyperdrive` item got
 * `TS2345: Argument of type 'Sql<{}>' is not assignable to parameter of type
 * 'PostgresJsLike'` while this gate stayed silent. Keep every difference above:
 * they are what makes the check mean anything. An unconstrained `T` accepts
 * `unsafe<string>(…)`, which the real package rejects; a bare `Promise<T>`
 * resolves to `unknown` where the real package hands back an iterable row array
 * carrying result metadata.
 *
 * `packages/hyperdrive/__tests__/postgres-shim-parity.test.ts` compiles the same
 * probes against this stub and against the installed `postgres` package and
 * fails when the two disagree — `tsc -p registry/tsconfig.json` alone can only
 * see this file, never the package it stands in for.
 */
declare module "postgres" {
    /** Stands in for postgres.js's `ParameterOrJSON<T>` union — the element type is not what this stub is testing. */
    type Parameter = unknown;

    /**
     * postgres.js's `Row`: an open record, and the basis of `unsafe`'s default
     * type argument. `any`, not `unknown`, because that is what the package
     * declares — and `T extends any[]` is the only constraint that also
     * satisfies `PendingQuery`'s own `readonly MaybeRow[]`.
     */
    interface Row {
        [column: string]: any;
    }

    /** postgres.js's `UnsafeQueryOptions` — the third argument an arrow-property projection cannot accept. */
    interface UnsafeQueryOptions {
        prepare?: boolean | undefined;
    }

    /** Stands in for postgres.js's `ResultQueryMeta` — the result metadata every row list carries alongside the rows. */
    interface ResultMeta {
        columns: unknown;
        command: string;
        count: number;
        state: unknown;
        statement: unknown;
    }

    /** postgres.js's `RowList<T>`: the rows themselves, iterable, plus the result metadata. */
    type RowList<T extends ReadonlyArray<unknown>> = Iterable<NonNullable<T[number]>> & ResultMeta & T;

    /**
     * postgres.js resolves to a thenable query object carrying the query
     * modifiers, not a bare `Promise`. Mirrors `PendingQuery` and the
     * `PendingQueryModifiers` it extends; the inner types are loosened for the
     * same reason `Parameter` is.
     */
    interface PendingQuery<T extends ReadonlyArray<Row | undefined>> extends Promise<RowList<T>> {
        cancel: () => void;
        cursor: (rows?: number) => AsyncIterable<Array<NonNullable<T[number]>>>;
        describe: () => Promise<unknown>;
        execute: () => this;
        forEach: (callback: (row: NonNullable<T[number]>) => void) => Promise<unknown>;
        raw: () => PendingQuery<T>;
        readable: () => Promise<import("node:stream").Readable>;
        simple: () => this;
        values: () => PendingQuery<T>;
        writable: () => Promise<import("node:stream").Writable>;
    }

    /** The postgres.js client, carrying the `unsafe` escape hatch `fromPostgresJs` consumes. */
    export interface Sql {
        unsafe<T extends any[] = Array<Iterable<Row> & Row>>(query: string, parameters?: Parameter[], queryOptions?: UnsafeQueryOptions): PendingQuery<T>;
    }

    const postgres: (connectionString: string, options?: Record<string, unknown>) => Sql;

    export default postgres;
}
