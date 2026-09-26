/**
 * Copying DO-backed auth from its un-pinned object into the jurisdiction-pinned one.
 *
 * A Durable Object name maps to a different object per jurisdiction, so pinning the
 * auth object (`.jurisdiction(j, { pinAuth: true })`) starts it empty while
 * every user, account and session stays in the object the un-pinned namespace still
 * resolves. This moves them across.
 *
 * ## Shape
 *
 * Neither object can read the other's storage, so the worker drives the copy and each
 * object serves one half over its secret-gated internal route ({@link MOVE_PATH}):
 * the source lists its tables and pages rows out, the target creates what it lacks
 * and applies rows. Every table in the source is moved, whatever its name: the
 * better-auth tables of whatever plugin set the app runs, the audit log, the rate
 * limiter, and anything added later. `user` goes first, then `account` and `session`,
 * and the unbounded audit and rate-limit tables last.
 *
 * ## A snapshot, reconciled
 *
 * The target records every source row it has applied ({@link COPIED_TABLE}: the row's
 * primary key and a digest of its values), in the same transaction as the row. That
 * record is what makes the copy safe to repeat and to resume:
 *
 * **Resumable.** Each table keeps a `rowid` cursor ({@link MARKER_TABLE}); a call
 * continues from it. One call does at most {@link MAX_PAGES_PER_CALL} pages and answers
 * `done: false` until the last.
 *
 * **Change-checked.** When a call reaches the end of every table, the source
 * fingerprints each table (count plus an order-independent sum of row digests,
 * streamed from the cursor, never collected) and compares it with the target's record.
 * That runs once per pass, not once per call, so a large table stays linear. An
 * update, a delete, or a new row reusing a freed `rowid` changes it; the table is then
 * re-scanned, and each row reconciled three-way against the record: a row the source
 * changed is updated in the target when the target still holds the copied version, and
 * a row the source deleted is deleted from the target on the same condition. Anything
 * the pinned object changed on its own side is a conflict.
 *
 * **Loud conflicts.** A source row that collides with a row the copy did not write (a
 * different row with the same key or unique value, such as a user who signed up in the
 * pinned object) fails the page with `AUTH_MOVE_CONFLICT`. Under `force` the pinned
 * object's row is kept and the collision is counted under `conflicts`.
 *
 * **Page-bounded.** Pages are {@link PAGE_ROWS} rows. Every statement binds at most one
 * row's columns plus its key, and none is a compound SELECT.
 *
 * `done: true` means the source's fingerprint of every table matches the target's
 * record. Purge re-checks the same fingerprints inside the transaction that drops.
 * @experimental
 */
/* eslint-disable unicorn/no-null -- SQL NULL: a bound parameter or a hashed column value must be `null`, which `undefined` is not */
import { LunoraError } from "@lunora/errors";

import { contentDigest } from "../../../shared/content-digest";
import { quoteIdentifier } from "../../../shared/quote-identifier";
import { decodeWire, encodeWire } from "../../../shared/wire-codec";
import type { DoStorageLike } from "./do-store";

/** The internal route both halves of the move are served on. Not part of `/api/auth/*`. */
const MOVE_PATH = "/__lunora/auth/move";

/** Per-table progress in the target: cursor, scan pass, whether the pass reached the end, and the source's columns. */
const MARKER_TABLE = "__lunora_auth_move__";

/** Every source row the target has applied: its key and the digest of its values as copied. */
const COPIED_TABLE = "__lunora_auth_move_rows__";

/**
 * Written to the source by a purge. Once purged, the object serves again with empty
 * tables (after a rollback, say), and a copy from it would read "every row deleted"
 * and sweep the pinned copies away: every source-side step refuses instead.
 */
const PURGED_TABLE = "__lunora_auth_purged__";

/** Rows per page. */
const PAGE_ROWS = 100;

/**
 * Pages one call copies before it returns `done: false`. A page is two Durable Object
 * fetches and a call adds five, so a call stays under the 50-subrequest limit of a
 * Workers Free plan; the next call resumes.
 */
const MAX_PAGES_PER_CALL = 16;

/** workerd's bound-parameter limit per statement. */
const MAX_BOUND_PARAMETERS = 100;

/** Fingerprint sums wrap at 64 bits. */
const DIGEST_MODULUS = 2n ** 64n;

/** Internal and reserved tables: SQLite's own, Cloudflare's `_cf_*`, and the move's own. */
const isReservedTable = (name: string): boolean =>
    name.startsWith("sqlite_") || name.startsWith("_cf_") || name === MARKER_TABLE || name === COPIED_TABLE || name === PURGED_TABLE;

type Row = Record<string, unknown>;

/** One source table, as the target needs it to recreate, fill and check it. */
interface MovableTable {
    columns: string[];
    indexes: { name: string; sql: string }[];
    name: string;
    rows: number;
    /** The source's `CREATE TABLE` statement. */
    sql: string;
}

/** What one table looked like after a copy call. */
interface AuthMoveTableReport {
    /** Rows that collided with a row the pinned object holds on its own, kept as they are (only under `force`). */
    conflicts: number;
    /** Rows this call inserted into the target. */
    copied: number;
    /** Rows this call deleted from the target because the source deleted them since they were copied. */
    deleted: number;
    /** Rows in the source object. */
    sourceRows: number;
    table: string;
    /** Rows in the target object after this call. */
    targetRows: number;
    /** Rows this call read that the target already held exactly. */
    unchanged: number;
    /** Rows this call updated in the target because the source changed them since they were copied. */
    updated: number;
}

/** The answer to one copy call. */
interface AuthMoveResult {
    /** `true` once every table is copied and matches the source's fingerprint; otherwise call again. */
    done: boolean;
    tables: AuthMoveTableReport[];
}

/** The worker-side move between the un-pinned and the pinned auth object. */
interface AuthJurisdictionMove {
    /**
     * Copy every table from the un-pinned object into the pinned one. Refuses, unless
     * `force` is set, a pinned object holding users the copy did not write, and a row
     * that collides with one.
     */
    copy: (options?: { force?: boolean }) => Promise<AuthMoveResult>;

    /**
     * Drop every table in the un-pinned object. Refused unless every table was copied
     * and still matches what was copied.
     */
    purge: () => Promise<{ dropped: string[] }>;
}

/** The target's physical table names that decide copy order. */
interface MoveOrder {
    first: string[];
    last: string[];
}

interface MoveContext {
    /** Called after a purge, so the object materialises its schema again on its next request. */
    onPurge: () => void;
    order: () => MoveOrder;
    /** Materialise the object's own schema; the target runs it before a copy touches it. */
    prepare: () => void;
    userTable: () => string;
}

interface Marker {
    after: number;
    columns: string[];
    done: boolean;
    pass: number;
    /** On the user table's marker: the highest user `rowid` already checked for sign-ups the copy did not write. */
    watermark: number;
}

type Counts = Pick<AuthMoveTableReport, "conflicts" | "copied" | "deleted" | "unchanged" | "updated">;

/**
 * Run synchronous SQL inside the object's transaction, so a throw part-way rolls back
 * everything before it. Chained off a resolved promise so a synchronous throw arrives
 * as the rejection the transaction rolls back on.
 */
const inTransaction = async <R>(storage: DoStorageLike, work: () => R): Promise<R> => storage.transaction(async () => Promise.resolve().then(work));

const all = (storage: DoStorageLike, query: string, ...bindings: unknown[]): Row[] => [...storage.sql.exec(query, ...bindings)];

const run = (storage: DoStorageLike, query: string, ...bindings: unknown[]): void => {
    [...storage.sql.exec(query, ...bindings)];
};

const tableNames = (storage: DoStorageLike): string[] =>
    all(storage, `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
        .map((row) => String(row["name"]))
        .filter((name) => !isReservedTable(name));

const tableInfo = (storage: DoStorageLike, table: string): { name: string; pk: number }[] =>
    all(storage, `SELECT name, pk FROM pragma_table_info(?)`, table).map((row) => {
        return { name: String(row["name"]), pk: Number(row["pk"]) };
    });

const columnNames = (storage: DoStorageLike, table: string): string[] => tableInfo(storage, table).map(({ name }) => name);

/** The primary-key columns, in key order; every column when the table declares none. */
const keyColumns = (storage: DoStorageLike, table: string): string[] => {
    const info = tableInfo(storage, table);
    const key = info
        .filter(({ pk }) => pk > 0)
        .toSorted((a, b) => a.pk - b.pk)
        .map(({ name }) => name);

    return key.length > 0 ? key : info.map(({ name }) => name);
};

const countRows = (storage: DoStorageLike, table: string): number => Number(all(storage, `SELECT count(*) AS n FROM ${quoteIdentifier(table)}`)[0]?.["n"] ?? 0);

/** A JSON string of wire-encoded values: stable for equal values, bytes included. */
const encodeValues = (values: unknown[]): string => JSON.stringify(encodeWire(values));

/** Digest of a row's values over `columns` (sorted), as a 64-bit integer. */
const rowDigest = (row: Row, columns: string[]): bigint => BigInt(`0x${contentDigest(encodeValues(columns.map((column) => row[column] ?? null)))}`);

/**
 * Count plus an order-independent sum of row digests, streamed: `rows` is a SQL cursor,
 * read one row at a time and never collected, so memory stays at one row.
 */
const fingerprintOf = (rows: Iterable<Row>, toDigest: (row: Row) => bigint): string => {
    let count = 0;
    let sum = 0n;

    for (const row of rows) {
        count += 1;
        sum = (sum + toDigest(row)) % DIGEST_MODULUS;
    }

    return `${String(count)}:${sum.toString(16)}`;
};

/** Source: fingerprint of a table's rows. */
const sourceFingerprint = (storage: DoStorageLike, table: string): string => {
    const columns = columnNames(storage, table).toSorted((a, b) => a.localeCompare(b));

    return fingerprintOf(storage.sql.exec(`SELECT * FROM ${quoteIdentifier(table)}`), (row) => rowDigest(row, columns));
};

/** Source: every table, with what the target needs to recreate it. */
const listMovableTables = (storage: DoStorageLike): MovableTable[] =>
    tableNames(storage).map((name) => {
        const definition = all(storage, `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, name)[0]?.["sql"];
        const indexes = all(storage, `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`, name).map((row) => {
            return { name: String(row["name"]), sql: String(row["sql"]) };
        });

        return {
            columns: columnNames(storage, name),
            indexes,
            name,
            rows: countRows(storage, name),
            sql: typeof definition === "string" ? definition : "",
        };
    });

const assertKnownTable = (storage: DoStorageLike, table: unknown): string => {
    if (typeof table !== "string" || !tableNames(storage).includes(table)) {
        throw new TypeError(`unknown table ${JSON.stringify(table)}`);
    }

    return table;
};

/** Source: up to {@link PAGE_ROWS} rows after `after`, in `rowid` order. */
const readPage = (storage: DoStorageLike, table: string, after: number): { last: number | undefined; rows: Row[] } => {
    const rows = all(storage, `SELECT rowid AS "__lunora_rowid__", * FROM ${quoteIdentifier(table)} WHERE rowid > ? ORDER BY rowid LIMIT ?`, after, PAGE_ROWS);
    const last = rows.at(-1)?.["__lunora_rowid__"];

    return {
        last: typeof last === "number" ? last : undefined,
        rows: rows.map(({ __lunora_rowid__: _rowid, ...row }) => row),
    };
};

const hasMarkers = (storage: DoStorageLike): boolean => columnNames(storage, MARKER_TABLE).length > 0;

const markers = (storage: DoStorageLike): Record<string, Marker> => {
    if (!hasMarkers(storage)) {
        return {};
    }

    return Object.fromEntries(
        all(storage, `SELECT tbl, after, done, pass, cols, watermark FROM ${quoteIdentifier(MARKER_TABLE)}`).map((row) => [
            String(row["tbl"]),
            {
                after: Number(row["after"]),
                columns: JSON.parse(String(row["cols"])) as string[],
                done: row["done"] === 1,
                pass: Number(row["pass"]),
                watermark: Number(row["watermark"]),
            },
        ]),
    );
};

/** Target: fingerprint of the rows the current pass has applied for `table`. */
const copiedFingerprint = (storage: DoStorageLike, table: string, pass: number): string =>
    fingerprintOf(storage.sql.exec(`SELECT h FROM ${quoteIdentifier(COPIED_TABLE)} WHERE tbl = ? AND pass = ?`, table, pass), (row) =>
        BigInt(`0x${String(row["h"])}`),
    );

const ensureMoveTables = (storage: DoStorageLike): void => {
    run(
        storage,
        `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(MARKER_TABLE)} (tbl TEXT NOT NULL PRIMARY KEY, after INTEGER NOT NULL, done INTEGER NOT NULL, pass INTEGER NOT NULL, cols TEXT NOT NULL, watermark INTEGER NOT NULL DEFAULT 0)`,
    );
    run(
        storage,
        `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(COPIED_TABLE)} (tbl TEXT NOT NULL, k TEXT NOT NULL, h TEXT NOT NULL, pass INTEGER NOT NULL, PRIMARY KEY (tbl, k))`,
    );
};

/**
 * Target: user rows above `watermark` the copy did not write — someone who signed up in
 * the pinned object. Only rows added since the last check are looked at, so this stays
 * cheap on every call. The key is matched in SQL: `json_array` of a text or integer key
 * spells what {@link encodeValues} records for it.
 */
const foreignUsers = (storage: DoStorageLike, userTable: string, watermark: number): number => {
    if (!tableNames(storage).includes(userTable)) {
        return 0;
    }

    const key = keyColumns(storage, userTable)
        .map((column) => `u.${quoteIdentifier(column)}`)
        .join(", ");

    return Number(
        all(
            storage,
            `SELECT count(*) AS n FROM ${quoteIdentifier(userTable)} u WHERE u.rowid > ? AND NOT EXISTS (SELECT 1 FROM ${quoteIdentifier(COPIED_TABLE)} c WHERE c.tbl = ? AND c.k = json_array(${key}))`,
            watermark,
            userTable,
        )[0]?.["n"] ?? 0,
    );
};

const DDL_TABLE = /^CREATE TABLE /iu;
const DDL_INDEX = /^CREATE (?:UNIQUE )?INDEX /iu;

/** Target: give `table` somewhere to land — create it from the source's DDL, or add the columns and indexes it lacks. */
const ensureTable = (storage: DoStorageLike, table: MovableTable, existing: Set<string>): void => {
    if (isReservedTable(table.name)) {
        throw new TypeError(`refusing reserved table ${JSON.stringify(table.name)}`);
    }

    // The source's own DDL. It came from this app's other auth object over the
    // secret-gated route; the prefix check keeps anything but a table or index
    // definition out regardless.
    if (!DDL_TABLE.test(table.sql) || table.indexes.some(({ sql }) => !DDL_INDEX.test(sql))) {
        throw new TypeError(`refusing unexpected DDL for ${JSON.stringify(table.name)}`);
    }

    if (existing.has(table.name)) {
        const present = new Set(columnNames(storage, table.name));

        // A column the source has and the target lacks (a plugin removed since, or an
        // older column the current schema dropped) is added untyped and nullable, so
        // the value still has somewhere to land.
        for (const column of table.columns.filter((name) => !present.has(name))) {
            run(storage, `ALTER TABLE ${quoteIdentifier(table.name)} ADD COLUMN ${quoteIdentifier(column)}`);
        }
    } else {
        run(storage, table.sql);
    }

    const indexes = new Set(all(storage, `SELECT name FROM sqlite_master WHERE type = 'index'`).map((row) => String(row["name"])));

    for (const index of table.indexes.filter(({ name }) => !indexes.has(name))) {
        run(storage, index.sql);
    }
};

/**
 * Target: prepare a call — refuse users the copy did not write unless forced, and give
 * every table somewhere to land.
 */
const beginMove = (
    storage: DoStorageLike,
    tables: MovableTable[],
    options: { force: boolean; userTable: string },
): { cursors: Record<string, number>; done: Record<string, boolean>; targetRows: Record<string, number> } => {
    ensureMoveTables(storage);

    const users = foreignUsers(storage, options.userTable, markers(storage)[options.userTable]?.watermark ?? 0);

    if (users > 0 && !options.force) {
        throw new LunoraError(
            "AUTH_MOVE_TARGET_NOT_EMPTY",
            `the pinned auth object has ${String(users)} user(s) the copy did not write; copying into it would merge two user bases — pass force to copy anyway`,
            { data: { users } },
        );
    }

    const existing = new Set(tableNames(storage));
    const known = markers(storage);

    for (const table of tables) {
        ensureTable(storage, table, existing);

        const marker = known[table.name];
        const columns = JSON.stringify(table.columns.toSorted((a, b) => a.localeCompare(b)));

        if (marker === undefined) {
            run(storage, `INSERT INTO ${quoteIdentifier(MARKER_TABLE)} (tbl, after, done, pass, cols) VALUES (?, 0, 0, 1, ?)`, table.name, columns);
        } else {
            run(storage, `UPDATE ${quoteIdentifier(MARKER_TABLE)} SET cols = ? WHERE tbl = ?`, columns, table.name);
        }
    }

    // Every user row present now was checked (or forced): the next call looks only above it.
    run(
        storage,
        `UPDATE ${quoteIdentifier(MARKER_TABLE)} SET watermark = (SELECT coalesce(max(rowid), 0) FROM ${quoteIdentifier(options.userTable)}) WHERE tbl = ?`,
        options.userTable,
    );

    const now = markers(storage);

    return {
        cursors: Object.fromEntries(tables.map(({ name }) => [name, now[name]?.after ?? 0])),
        done: Object.fromEntries(tables.map(({ name }) => [name, now[name]?.done ?? false])),
        targetRows: Object.fromEntries(tables.map(({ name }) => [name, countRows(storage, name)])),
    };
};

/** The target's current values of the row with `key`, restricted to `columns`, or `undefined`. */
const targetRow = (storage: DoStorageLike, table: string, keys: string[], key: unknown[], columns: string[]): Row | undefined =>
    all(
        storage,
        `SELECT ${columns.map((column) => quoteIdentifier(column)).join(", ")} FROM ${quoteIdentifier(table)} WHERE ${keys.map((column) => `${quoteIdentifier(column)} IS ?`).join(" AND ")} LIMIT 1`,
        ...key,
    )[0];

/** A collision: loud without `force`; under it, the pinned object's row is kept and counted. */
const conflict = (table: string, force: boolean): "conflicts" => {
    if (!force) {
        throw new LunoraError(
            "AUTH_MOVE_CONFLICT",
            `a row copied into ${table} collides with a row the pinned auth object holds on its own — nothing from this page was written; pass force to keep the pinned object's rows`,
            { data: { table } },
        );
    }

    return "conflicts";
};

const isUniqueViolation = (error: unknown): boolean => error instanceof Error && error.message.includes("UNIQUE constraint failed");

type Outcome = keyof Counts;

interface RowPlan {
    columns: string[];
    force: boolean;
    h: string;
    key: unknown[];
    keys: string[];
    prior: string | undefined;
    row: Row;
    table: string;
}

/** A row the target does not hold under its key: insert it, unless the pinned object deleted the copied version. */
const placeAbsent = (storage: DoStorageLike, plan: RowPlan): Outcome => {
    if (plan.prior !== undefined) {
        // Copied before, since deleted in the pinned object, and now changed in the source.
        return conflict(plan.table, plan.force);
    }

    try {
        run(
            storage,
            `INSERT INTO ${quoteIdentifier(plan.table)} (${plan.columns.map((column) => quoteIdentifier(column)).join(", ")}) VALUES (${plan.columns.map(() => "?").join(", ")})`,
            ...plan.columns.map((column) => plan.row[column]),
        );
    } catch (error) {
        if (!isUniqueViolation(error)) {
            throw error;
        }

        return conflict(plan.table, plan.force);
    }

    return "copied";
};

/** A row the target holds under its key: leave it, take the source's change, or collide. */
const placePresent = (storage: DoStorageLike, plan: RowPlan, current: Row): Outcome => {
    const held = rowDigest(current, plan.columns).toString(16);

    if (held === plan.h) {
        return "unchanged";
    }

    if (plan.prior === undefined || held !== plan.prior) {
        return conflict(plan.table, plan.force);
    }

    // The pinned object still holds the copied version: take the source's change.
    run(
        storage,
        `UPDATE ${quoteIdentifier(plan.table)} SET ${plan.columns.map((column) => `${quoteIdentifier(column)} = ?`).join(", ")} WHERE ${plan.keys.map((column) => `${quoteIdentifier(column)} IS ?`).join(" AND ")}`,
        ...plan.columns.map((column) => plan.row[column]),
        ...plan.key,
    );

    return "updated";
};

/** Apply one source row, depending on what was copied before and what the target holds now, and record it. */
const applyRow = (storage: DoStorageLike, table: string, row: Row, context: { force: boolean; keys: string[]; pass: number }): Outcome => {
    const { force, keys, pass } = context;
    const columns = Object.keys(row).toSorted((a, b) => a.localeCompare(b));

    if (columns.length + keys.length > MAX_BOUND_PARAMETERS) {
        throw new TypeError(`${table} has too many columns to copy`);
    }

    const key = keys.map((column) => row[column] ?? null);
    const k = encodeValues(key);
    const h = rowDigest(row, columns).toString(16);
    const prior = all(storage, `SELECT h FROM ${quoteIdentifier(COPIED_TABLE)} WHERE tbl = ? AND k = ?`, table, k)[0]?.["h"];
    const plan: RowPlan = { columns, force, h, key, keys, prior: typeof prior === "string" ? prior : undefined, row, table };
    const current = plan.prior === h ? undefined : targetRow(storage, table, keys, key, columns);
    let outcome: Outcome = "unchanged";

    if (plan.prior !== h) {
        outcome = current === undefined ? placeAbsent(storage, plan) : placePresent(storage, plan, current);
    }

    run(
        storage,
        `INSERT INTO ${quoteIdentifier(COPIED_TABLE)} (tbl, k, h, pass) VALUES (?, ?, ?, ?) ON CONFLICT (tbl, k) DO UPDATE SET h = excluded.h, pass = excluded.pass`,
        table,
        k,
        h,
        pass,
    );

    return outcome;
};

/** Target: rows applied in an earlier pass the source no longer has — delete them where the target still holds the copied version. */
const sweepDeleted = (storage: DoStorageLike, table: string, context: { counts: Counts; force: boolean; keys: string[]; marker: Marker }): void => {
    const { counts, force, keys, marker } = context;
    const stale = all(storage, `SELECT k, h FROM ${quoteIdentifier(COPIED_TABLE)} WHERE tbl = ? AND pass < ?`, table, marker.pass);

    for (const entry of stale) {
        const key = decodeWire(JSON.parse(String(entry["k"]))) as unknown[];
        const current = targetRow(storage, table, keys, key, marker.columns);

        if (current !== undefined) {
            if (rowDigest(current, marker.columns).toString(16) === String(entry["h"])) {
                run(storage, `DELETE FROM ${quoteIdentifier(table)} WHERE ${keys.map((column) => `${quoteIdentifier(column)} IS ?`).join(" AND ")}`, ...key);
                counts.deleted += 1;
            } else {
                // Deleted in the source, changed in the pinned object.
                counts[conflict(table, force)] += 1;
            }
        }

        run(storage, `DELETE FROM ${quoteIdentifier(COPIED_TABLE)} WHERE tbl = ? AND k = ?`, table, String(entry["k"]));
    }
};

/** Target: apply one page and advance the table's cursor, atomically. `final` closes the pass. */
const writePage = async (storage: DoStorageLike, table: string, page: { final: boolean; force: boolean; last: number; rows: Row[] }): Promise<Counts> => {
    const marker = markers(storage)[table];

    if (marker === undefined) {
        throw new TypeError(`table ${JSON.stringify(table)} was not part of this move`);
    }

    return inTransaction(storage, () => {
        const counts: Counts = { conflicts: 0, copied: 0, deleted: 0, unchanged: 0, updated: 0 };
        const keys = keyColumns(storage, table);

        for (const row of page.rows) {
            counts[applyRow(storage, table, row, { force: page.force, keys, pass: marker.pass })] += 1;
        }

        if (page.final) {
            sweepDeleted(storage, table, { counts, force: page.force, keys, marker });
        }

        run(storage, `UPDATE ${quoteIdentifier(MARKER_TABLE)} SET after = ?, done = ? WHERE tbl = ?`, page.last, page.final ? 1 : 0, table);

        return counts;
    });
};

/**
 * Source: drop every table, but only if each one still matches the fingerprint the
 * target recorded for it. Checked inside the transaction that drops, so nothing can
 * change between the check and the drop.
 */
const purgeSource = async (storage: DoStorageLike, expected: Record<string, string>): Promise<{ dropped: string[] }> => {
    const dropped = tableNames(storage);

    await inTransaction(storage, () => {
        const unfinished = dropped.filter((table) => expected[table] === undefined);

        if (unfinished.length > 0) {
            throw new LunoraError(
                "AUTH_MOVE_INCOMPLETE",
                `refusing to purge the un-pinned auth object: ${unfinished.join(", ")} not fully copied — run the copy to done: true first`,
                { data: { unfinished } },
            );
        }

        const changed = dropped.filter((table) => sourceFingerprint(storage, table) !== expected[table]);

        if (changed.length > 0) {
            throw new LunoraError(
                "AUTH_MOVE_SOURCE_CHANGED",
                `refusing to purge the un-pinned auth object: ${changed.join(", ")} changed since it was copied — run the copy again to carry the changes, then purge`,
                { data: { changed } },
            );
        }

        for (const table of dropped) {
            run(storage, `DROP TABLE ${quoteIdentifier(table)}`);
        }

        run(storage, `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(PURGED_TABLE)} (at INTEGER NOT NULL)`);
        run(storage, `INSERT INTO ${quoteIdentifier(PURGED_TABLE)} (at) VALUES (?)`, Date.now());
    });

    return { dropped };
};

/** Source: refuse every step once this object has been purged. */
const assertNotPurged = (storage: DoStorageLike): void => {
    if (columnNames(storage, PURGED_TABLE).length > 0) {
        throw new LunoraError(
            "AUTH_MOVE_SOURCE_PURGED",
            "the un-pinned auth object was purged after its tables were copied; anything in it now is new, and copying it would delete the pinned object's users",
        );
    }
};

/** The ops served by the un-pinned object. */
const SOURCE_OPS = new Set(["fingerprints", "manifest", "page", "purge"]);

/**
 * Target: markers and the copy order, plus — only when asked, since it reads every
 * copied row — the fingerprint of what each table's current pass copied.
 */
const status = (
    storage: DoStorageLike,
    context: MoveContext,
    withFingerprints: boolean,
): { copied: Record<string, string>; markers: Record<string, Marker>; order: MoveOrder } => {
    context.prepare();

    const current = markers(storage);

    return {
        copied: withFingerprints
            ? Object.fromEntries(Object.entries(current).map(([table, marker]) => [table, copiedFingerprint(storage, table, marker.pass)]))
            : {},
        markers: current,
        order: context.order(),
    };
};

/** Target: scan these tables again from the start, under a new pass, because the source changed them after they were copied. */
const rescan = (storage: DoStorageLike, tables: string[]): Record<string, never> => {
    for (const table of tables) {
        run(storage, `UPDATE ${quoteIdentifier(MARKER_TABLE)} SET after = 0, done = 0, pass = pass + 1 WHERE tbl = ?`, table);
    }

    return {};
};

const SAFE_CAUSES = [
    /(?:UNIQUE|NOT NULL|CHECK|FOREIGN KEY|PRIMARY KEY) constraint failed/u,
    /no such (?:table|column)/u,
    /datatype mismatch/u,
    /SQLITE_[A-Z_]+/u,
];

/** A class for a failed step's cause that is safe to hand the admin caller: never row data. */
const safeCause = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error);

    for (const pattern of SAFE_CAUSES) {
        const match = pattern.exec(message);

        if (match) {
            return match[0];
        }
    }

    return error instanceof Error ? error.name : "unknown";
};

const dispatch = async (storage: DoStorageLike, body: Row, context: MoveContext): Promise<unknown> => {
    if (SOURCE_OPS.has(String(body["op"]))) {
        assertNotPurged(storage);
    }

    switch (body["op"]) {
        case "begin": {
            context.prepare();

            return beginMove(storage, body["tables"] as MovableTable[], { force: body["force"] === true, userTable: context.userTable() });
        }
        case "fingerprints": {
            return { fingerprints: Object.fromEntries(tableNames(storage).map((table) => [table, sourceFingerprint(storage, table)])) };
        }
        case "manifest": {
            return { tables: listMovableTables(storage) };
        }
        case "page": {
            const page = readPage(storage, assertKnownTable(storage, body["table"]), Number(body["after"] ?? 0));

            return { last: page.last, rows: encodeWire(page.rows) };
        }
        case "purge": {
            const result = await purgeSource(storage, (body["expected"] ?? {}) as Record<string, string>);

            context.onPurge();

            return result;
        }
        case "rescan": {
            return rescan(storage, (body["tables"] ?? []) as string[]);
        }
        case "status": {
            return status(storage, context, body["fingerprints"] === true);
        }
        case "write": {
            return writePage(storage, assertKnownTable(storage, body["table"]), {
                final: body["final"] === true,
                force: body["force"] === true,
                last: Number(body["last"]),
                rows: decodeWire(body["rows"]) as Row[],
            });
        }
        default: {
            throw new TypeError(`unknown move op ${JSON.stringify(body["op"])}`);
        }
    }
};

/**
 * Serve one half of the move inside an auth object. A failure that is not already a
 * `LunoraError` becomes `AUTH_MOVE_FAILED` naming the step, the table and a safe
 * class of the cause; the full error is logged here.
 */
const handleMoveRequest = async (storage: DoStorageLike, body: Row, context: MoveContext): Promise<unknown> => {
    try {
        return await dispatch(storage, body, context);
    } catch (error) {
        if (error instanceof LunoraError) {
            throw error;
        }

        // eslint-disable-next-line no-console -- no injected logger at this layer (workerd/Node both capture console)
        console.error("@lunora/auth: auth move step failed", error);

        const op = String(body["op"]);
        const table = typeof body["table"] === "string" ? body["table"] : undefined;
        const cause = safeCause(error);

        throw new LunoraError("AUTH_MOVE_FAILED", `auth move ${op}${table === undefined ? "" : ` on ${table}`} failed: ${cause}`, {
            data: { cause, op, ...(table === undefined ? {} : { table }) },
        });
    }
};

/** Which object a move request goes to: the un-pinned `source` or the pinned `target`. */
type MoveSide = "source" | "target";

type StatusReply = ReturnType<typeof status>;

/** `user`, `account`, `session` first; the unbounded audit and rate-limit tables last; the rest by name. */
const sortTables = (tables: MovableTable[], order: MoveOrder): MovableTable[] => {
    const rank = (name: string): number => {
        const first = order.first.indexOf(name);

        if (first !== -1) {
            return first;
        }

        const last = order.last.indexOf(name);

        return last === -1 ? order.first.length : order.first.length + 1 + last;
    };

    return tables.toSorted((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
};

const emptyReport = (table: MovableTable, targetRows: number): AuthMoveTableReport => {
    return { conflicts: 0, copied: 0, deleted: 0, sourceRows: table.rows, table: table.name, targetRows, unchanged: 0, updated: 0 };
};

/**
 * The worker-side driver.
 * @param post Send one move request body to {@link MOVE_PATH} on that side's object, with the internal secret.
 */
const createAuthJurisdictionMove = (post: (side: MoveSide, body: Row) => Promise<Response>): AuthJurisdictionMove => {
    const call = async <T>(side: MoveSide, body: Row): Promise<T> => {
        const response = await post(side, body);

        if (!response.ok) {
            let error: { code?: string; data?: unknown; message?: string } = {};

            try {
                const payload: { error?: unknown } = await response.json();

                if (typeof payload.error === "object" && payload.error !== null) {
                    error = payload.error;
                }
            } catch {
                // Not JSON: the status alone is all there is.
            }

            throw new LunoraError(
                error.code ?? "AUTH_MOVE_FAILED",
                error.message ?? `auth move ${String(body["op"])} on the ${side} object failed (${String(response.status)})`,
                { data: error.data, status: response.status },
            );
        }

        return response.json();
    };

    return {
        copy: async (options = {}) => {
            const force = options.force === true;
            const before = await call<StatusReply>("target", { op: "status" });
            const { tables } = await call<{ tables: MovableTable[] }>("source", { op: "manifest" });
            const begun = await call<ReturnType<typeof beginMove>>("target", { force, op: "begin", tables });
            const reports: AuthMoveTableReport[] = [];
            let pages = 0;

            for (const table of sortTables(tables, before.order)) {
                const report = emptyReport(table, begun.targetRows[table.name] ?? 0);
                let after = begun.cursors[table.name] ?? 0;

                reports.push(report);

                for (;;) {
                    if (pages >= MAX_PAGES_PER_CALL) {
                        return { done: false, tables: reports };
                    }

                    pages += 1;

                    // eslint-disable-next-line no-await-in-loop -- each page starts at the previous page's cursor
                    const page = await call<{ last?: number; rows: unknown }>("source", { after, op: "page", table: table.name });
                    const rows = decodeWire(page.rows) as Row[];
                    const final = rows.length < PAGE_ROWS;

                    if (rows.length === 0 && begun.done[table.name] === true) {
                        break;
                    }

                    // eslint-disable-next-line no-await-in-loop -- the write advances the cursor the next read starts from
                    const counts = await call<Counts>("target", { final, force, last: page.last ?? after, op: "write", rows: page.rows, table: table.name });

                    report.conflicts += counts.conflicts;
                    report.copied += counts.copied;
                    report.deleted += counts.deleted;
                    report.unchanged += counts.unchanged;
                    report.updated += counts.updated;
                    report.targetRows += counts.copied - counts.deleted;
                    after = page.last ?? after;

                    if (final) {
                        break;
                    }
                }
            }

            // Every table reached its end in this pass: the one point that checks the
            // copy against the source as it is now. A table that changed after its rows
            // were read (mid-copy, or since a finished copy) is scanned again, and the
            // next call reconciles it.
            const { fingerprints } = await call<{ fingerprints: Record<string, string> }>("source", { op: "fingerprints" });
            const after = await call<StatusReply>("target", { fingerprints: true, op: "status" });
            const changed = Object.keys(fingerprints).filter((table) => after.copied[table] !== fingerprints[table]);

            if (changed.length > 0) {
                await call("target", { op: "rescan", tables: changed });
            }

            return { done: changed.length === 0, tables: reports };
        },
        purge: async () => {
            const { copied, markers: current } = await call<StatusReply>("target", { fingerprints: true, op: "status" });
            const expected = Object.fromEntries(
                Object.entries(current)
                    .filter(([, marker]) => marker.done)
                    .map(([table]) => [table, copied[table]]),
            );

            return call<{ dropped: string[] }>("source", { expected, op: "purge" });
        },
    };
};

export type { AuthJurisdictionMove, AuthMoveResult, AuthMoveTableReport, MoveOrder, MoveSide };
export { createAuthJurisdictionMove, handleMoveRequest, MAX_PAGES_PER_CALL, MOVE_PATH, PAGE_ROWS };
