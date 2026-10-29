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
 * A stub can also be wrong in the OPPOSITE direction, and here that is just as
 * bad: a field erased to `unknown`, or a callback argument left off, rejects
 * code the real package accepts — so the standalone check reports a failure no
 * consumer will ever see. `columns` / `state` / `statement`, `forEach`'s result
 * argument, `cursor`'s callback overloads and the distinct `raw()` / `values()`
 * result shapes are spelled out below for that reason. Loosen a type only where
 * the difference cannot produce a verdict: `Parameter`, and `Column`'s `name`,
 * which the real declaration narrows to the row's key union.
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

    /**
     * postgres.js's `Column<T>`. `name` is widened to `string`: the real
     * declaration narrows it to the row's key union, which this stub has no row
     * type to derive — and a widened `name` still accepts every read the real
     * one does, so it cannot manufacture a disagreement.
     */
    interface Column {
        name: string;
        number: number;
        parser?: ((raw: string) => unknown) | undefined;
        table: number;
        type: number;
    }

    /** postgres.js's `State` — the connection a result came back on. */
    interface State {
        pid: number;
        secret: number;
        status: string;
    }

    /** postgres.js's `Statement` — the prepared statement a result was produced by. */
    interface Statement {
        columns: Column[];
        name: string;
        string: string;
        types: number[];
    }

    /** Stands in for postgres.js's `ResultQueryMeta` — the result metadata every row list carries alongside the rows. */
    interface ResultMeta {
        columns: Column[];
        command: string;
        count: number;
        state: State;
        statement: Statement;
    }

    /** postgres.js's `ExecutionResult`: the metadata with no rows, which is what a streaming read resolves to. */
    type ExecutionResult = [] & ResultMeta;

    /** postgres.js's `RowList<T>`: the rows themselves, iterable, plus the result metadata. */
    type RowList<T extends ReadonlyArray<unknown>> = Iterable<NonNullable<T[number]>> & ResultMeta & T;

    /** One `.values()` row: the row's values POSITIONALLY, not a keyed object. */
    type ValuesRow<T extends ReadonlyArray<unknown>> = Array<NonNullable<T[number]>[keyof NonNullable<T[number]>]>;

    /** One `.raw()` row: the wire bytes of each column, unparsed. */
    type RawRow = Array<import("node:buffer").Buffer>;

    /** postgres.js's `ValuesRowList<T>`. */
    type ValuesRowList<T extends ReadonlyArray<unknown>> = Array<ValuesRow<T>> & ResultMeta;

    /** postgres.js's `RawRowList<T>`. */
    type RawRowList = Array<RawRow> & Iterable<Array<RawRow>> & ResultMeta;

    /**
     * postgres.js's `PendingQueryModifiers` — shared by every pending shape and
     * parameterised by the ROW type that shape yields, so `forEach` and `cursor`
     * hand back positional arrays under `PendingValuesQuery` and `Buffer` arrays
     * under `PendingRawQuery`. Method syntax, because `cursor` is overloaded.
     */
    interface PendingQueryModifiers<T extends ReadonlyArray<unknown>> {
        cancel(this: void): void;
        cursor(this: void, rows?: number): AsyncIterable<Array<NonNullable<T[number]>>>;
        cursor(this: void, callback: (row: [NonNullable<T[number]>]) => void): Promise<ExecutionResult>;
        cursor(this: void, rows: number, callback: (rows: Array<NonNullable<T[number]>>) => void): Promise<ExecutionResult>;
        execute(this: void): this;
        forEach(this: void, callback: (row: NonNullable<T[number]>, result: ExecutionResult) => void): Promise<ExecutionResult>;
        readable(this: void): Promise<import("node:stream").Readable>;
        simple(this: void): this;
        writable(this: void): Promise<import("node:stream").Writable>;
    }

    /** What `.values()` returns: positional arrays, and no further `.raw()` / `.values()` hop. */
    interface PendingValuesQuery<T extends ReadonlyArray<Row | undefined>> extends Promise<ValuesRowList<T>>, PendingQueryModifiers<Array<ValuesRow<T>>> {
        describe(this: void): Promise<Statement>;
    }

    /** What `.raw()` returns: unparsed column bytes, and — matching postgres.js — no `describe`. */
    interface PendingRawQuery<T extends ReadonlyArray<Row | undefined>> extends Promise<RawRowList>, PendingQueryModifiers<Array<RawRow>> {}

    /**
     * postgres.js resolves to a thenable query object carrying the query
     * modifiers, not a bare `Promise`. Mirrors `PendingQuery` and the
     * `PendingQueryModifiers` it extends.
     */
    interface PendingQuery<T extends ReadonlyArray<Row | undefined>> extends Promise<RowList<T>>, PendingQueryModifiers<T> {
        describe(this: void): Promise<Statement>;
        raw(this: void): PendingRawQuery<T>;
        values(this: void): PendingValuesQuery<T>;
    }

    /** The postgres.js client, carrying the `unsafe` escape hatch `fromPostgresJs` consumes. */
    export interface Sql {
        unsafe<T extends any[] = Array<Iterable<Row> & Row>>(query: string, parameters?: Parameter[], queryOptions?: UnsafeQueryOptions): PendingQuery<T>;
    }

    const postgres: (connectionString: string, options?: Record<string, unknown>) => Sql;

    export default postgres;
}
