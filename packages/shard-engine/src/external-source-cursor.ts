/**
 * Durable cursor/watermark storage for incremental external-source ingest
 * (plan 136). Full-pull mode is stateless — the table IS the baseline. Incremental
 * mode pulls only rows past a watermark, so it needs that watermark to survive
 * hibernation/eviction, plus a last-reconcile timestamp driving the periodic
 * full-pull sweep that GCs deletes. Both live in the reserved
 * `__lunora_source_cursor` table, keyed by `(table_name, shard_key)` — the shard
 * is already the DO's identity, but keying it explicitly keeps a future
 * multi-shard host honest and matches the manual bridge's mental model.
 *
 * The watermark is stored as a **tagged string** (`n:`/`b:`/`d:`/`s:`) so the
 * cursor column's native type (number, bigint, `Date`, ISO string) round-trips
 * through SQLite TEXT and rehydrates to the same JS type when bound back into the
 * incremental query. {@link maxCursorValue} advances it monotonically across a
 * pulled slice; the DB does the `>`/`>=` comparison, this only tracks the high
 * mark to bind next tick.
 */

import { sql as dsql } from "drizzle-orm";

import type { SqlExec } from "./ctx-db";
import { runDrizzle } from "./do-exec";

/** Reserved per-(table, shard) cursor table. Auto-hidden from the data browser by the `__lunora` prefix. */
const SOURCE_CURSOR_TABLE = "__lunora_source_cursor";

/** A cursor column value the watermark can track: a monotonic scalar the upstream DB can compare with `>`. */
type CursorValue = Date | bigint | number | string;

/** The durable ingest state for one sourced (table, shard): the serialized watermark and the last full-pull reconcile time. */
interface SourceCursorState {
    /** Wall-clock millis of the last full-pull reconcile sweep, or `null` before the first one. */
    lastReconcileMs: number | null;
    /** Serialized high-watermark of the cursor column (see {@link serializeCursor}), or `null` before the first pull. */
    watermark: string | null;
}

/**
 * Serialize a cursor value to a type-tagged string so its native type survives
 * SQLite TEXT storage and rehydrates identically when bound back into the query.
 * `Date` → `d:<iso>`, `bigint` → `b:<digits>`, `number` → `n:<num>`, everything
 * else → `s:<string>`.
 */
const serializeCursor = (value: CursorValue): string => {
    if (value instanceof Date) {
        return `d:${value.toISOString()}`;
    }

    if (typeof value === "bigint") {
        return `b:${value.toString()}`;
    }

    if (typeof value === "number") {
        return `n:${value.toString()}`;
    }

    return `s:${value}`;
};

/** Rehydrate a {@link serializeCursor} string back to its native cursor value for binding into the incremental query. */
// eslint-disable-next-line sonarjs/function-return-type -- deserialization genuinely reconstructs one of several native types from the tag; the union return is the point.
const deserializeCursor = (text: string): CursorValue => {
    const rest = text.slice(2);

    switch (text[0]) {
        case "b": {
            return BigInt(rest);
        }
        case "d": {
            return new Date(rest);
        }
        case "n": {
            return Number(rest);
        }
        default: {
            return rest;
        }
    }
};

/** Matches an integer literal (Postgres `bigint`/`int8` cursor columns come back from node-postgres as these). */
const INTEGER_STRING = /^-?\d+$/;

/** Matches a decimal literal (Postgres `numeric`/`decimal` come back as these). */
const DECIMAL_STRING = /^-?\d+(?:\.\d+)?$/;

/**
 * `true` when `a` orders strictly after `b`. Values are compared within their
 * primitive family — the cursor column is homogeneous by contract: `Date`s by
 * instant, `bigint`s by value (no `Number` cast, which would lose precision past
 * 2^53), plain numbers numerically.
 *
 * **Numeric-string columns.** A Postgres `bigint`/`numeric`/`decimal` cursor column
 * is returned by node-postgres (and therefore Hyperdrive's `SqlClient`) as a JS
 * **string**, not a number — so a naive `String(a) > String(b)` would compare
 * `"9" > "10"` lexically (`true`) and strand the watermark below the real max. Two
 * numeric strings are therefore compared numerically: as `bigint` when both are
 * integers (precision-safe), as `number` when either is a decimal. Non-numeric
 * strings (ISO timestamps) keep lexical order, which is chronological for ISO.
 */
const cursorAfter = (a: CursorValue, b: CursorValue): boolean => {
    if (a instanceof Date && b instanceof Date) {
        return a.getTime() > b.getTime();
    }

    if (typeof a === "bigint" && typeof b === "bigint") {
        return a > b;
    }

    if (typeof a === "number" && typeof b === "number") {
        return a > b;
    }

    if (typeof a === "string" && typeof b === "string" && DECIMAL_STRING.test(a) && DECIMAL_STRING.test(b)) {
        if (INTEGER_STRING.test(a) && INTEGER_STRING.test(b)) {
            return BigInt(a) > BigInt(b);
        }

        return Number(a) > Number(b);
    }

    return String(a) > String(b);
};

/**
 * Advance a serialized watermark across `rows`' `column` values: returns the
 * serialized max of the current watermark and every non-null cursor value in the
 * slice, or the unchanged `current` when the slice adds nothing higher. Rows
 * missing the column (or carrying `null`/`undefined`) are skipped — a
 * misconfigured cursor column simply never advances rather than corrupting state.
 */
const maxCursorValue = (rows: ReadonlyArray<Record<string, unknown>>, column: string, current: string | null): string | null => {
    let best: CursorValue | undefined = current === null ? undefined : deserializeCursor(current);

    for (const row of rows) {
        const raw = row[column];

        if (raw === null || raw === undefined) {
            continue;
        }

        const value = raw as CursorValue;

        if (best === undefined || cursorAfter(value, best)) {
            best = value;
        }
    }

    // eslint-disable-next-line unicorn/no-null -- `string | null` is the stored-watermark shape (null = "no watermark yet", mapping to SQL NULL).
    return best === undefined ? null : serializeCursor(best);
};

/** Create the reserved `__lunora_source_cursor` table. Idempotent; called at the head of each incremental tick (only incremental schemas pay for it). */
const migrateSourceCursor = (sql: SqlExec): void => {
    runDrizzle(
        sql,
        dsql`CREATE TABLE IF NOT EXISTS ${dsql.identifier(SOURCE_CURSOR_TABLE)} (
            table_name TEXT NOT NULL,
            shard_key TEXT NOT NULL,
            watermark TEXT,
            last_reconcile_ms INTEGER,
            PRIMARY KEY (table_name, shard_key)
        )`,
    );
};

/** Read the durable ingest state for `(table, shardKey)`, or the all-`null` initial state when the source has never polled in this DO. */
const readSourceCursor = (sql: SqlExec, table: string, shardKey: string): SourceCursorState => {
    const rows = runDrizzle<{ last_reconcile_ms: number | null; watermark: string | null }>(
        sql,
        dsql`SELECT watermark, last_reconcile_ms FROM ${dsql.identifier(SOURCE_CURSOR_TABLE)} WHERE table_name = ${table} AND shard_key = ${shardKey} LIMIT 1`,
    ).toArray();

    const row = rows[0];

    // eslint-disable-next-line unicorn/no-null -- SQL NULL is the correct absent-value for a never-polled (table, shard); `SourceCursorState` is `… | null`.
    return { lastReconcileMs: row?.last_reconcile_ms ?? null, watermark: row?.watermark ?? null };
};

/**
 * Persist the ingest state for `(table, shardKey)` (upsert). Written in the same
 * storage transaction as the materialize apply so a watermark can never advance
 * past rows that failed to land — a partial-failure tick rolls both back and the
 * next tick re-pulls from the prior mark.
 */
const writeSourceCursor = (sql: SqlExec, table: string, shardKey: string, state: SourceCursorState): void => {
    runDrizzle(
        sql,
        dsql`INSERT INTO ${dsql.identifier(SOURCE_CURSOR_TABLE)} (table_name, shard_key, watermark, last_reconcile_ms)
             VALUES (${table}, ${shardKey}, ${state.watermark}, ${state.lastReconcileMs})
             ON CONFLICT(table_name, shard_key) DO UPDATE SET watermark = excluded.watermark, last_reconcile_ms = excluded.last_reconcile_ms`,
    );
};

export { cursorAfter, deserializeCursor, maxCursorValue, migrateSourceCursor, readSourceCursor, serializeCursor, SOURCE_CURSOR_TABLE, writeSourceCursor };
export type { CursorValue, SourceCursorState };
