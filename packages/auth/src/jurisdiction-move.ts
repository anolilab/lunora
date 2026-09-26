/**
 * Copying DO-backed auth from its un-pinned object into the jurisdiction-pinned one.
 *
 * A Durable Object name maps to a different object per jurisdiction, so pinning the
 * auth object (`.jurisdiction(j, { pinAuthAndVoice: true })`) starts it empty while
 * every user, account and session stays in the object the un-pinned namespace still
 * resolves. This moves them across.
 *
 * ## Shape
 *
 * Neither object can read the other's storage, so the worker drives the copy and each
 * object serves one half over its secret-gated internal route ({@link MOVE_PATH}):
 * the source lists its tables and pages rows out, the target creates what it lacks
 * and writes rows in. Every table in the source is moved, whatever its name: the
 * better-auth tables of whatever plugin set the app runs, the audit log, the rate
 * limiter, and anything added later.
 *
 * ## Safe to re-run
 *
 * **Idempotent.** A row is written with `ON CONFLICT DO NOTHING`, so a row already in
 * the target is left alone. Not `INSERT OR IGNORE`: that also swallows a `NOT NULL`
 * violation, which would drop a row silently and still report success.
 *
 * **Resumable.** The target records, per table, the last source `rowid` it wrote (in
 * {@link MARKER_TABLE}, in the same transaction as the rows), and a run starts from
 * there. One call does at most {@link MAX_PAGES_PER_CALL} pages, so a large object
 * takes several calls; each answers `done: false` until the last.
 *
 * **Page-bounded.** Pages are {@link PAGE_ROWS} rows, each written with its own
 * `INSERT`, which binds one row's columns; workerd caps a table at 100 columns, so no
 * statement can pass its 100-parameter limit. No statement is a compound SELECT.
 * @experimental
 */
import { LunoraError } from "@lunora/errors";

import { decodeWire, encodeWire } from "../../../shared/wire-codec";
import type { DoStorageLike } from "./do-store";

/** The internal route both halves of the move are served on. Not part of `/api/auth/*`. */
const MOVE_PATH = "/__lunora/auth/move";

/**
 * Per-table copy progress, kept in the target: the last source `rowid` written, and
 * whether the table was finished. Never copied itself.
 */
const MARKER_TABLE = "__lunora_auth_move__";

/** Rows per page. */
const PAGE_ROWS = 100;

/**
 * Pages one call copies before it returns `done: false`. Each page is two
 * subrequests (read, write), so this stays well inside a Worker's subrequest budget.
 */
const MAX_PAGES_PER_CALL = 200;

/** Internal and reserved tables: SQLite's own, and Cloudflare's `_cf_*`. */
const isReservedTable = (name: string): boolean => name.startsWith("sqlite_") || name.startsWith("_cf_") || name === MARKER_TABLE;

const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** One source table, as the target needs it to recreate and fill it. */
interface MovableTable {
    columns: string[];
    /** `CREATE INDEX` statements, for a table the target does not have yet. */
    indexes: string[];
    name: string;
    rows: number;
    /** The source's `CREATE TABLE` statement. */
    sql: string;
}

/** What one table looked like after a copy call. */
interface AuthMoveTableReport {
    /** Rows this call wrote into the target. */
    copied: number;
    /** Rows this call read that the target already had (a re-run, or a conflict under `force`). */
    skipped: number;
    /** Rows in the source object. */
    sourceRows: number;
    table: string;
    /** Rows in the target object after this call. */
    targetRows: number;
}

/** The answer to one copy call. */
interface AuthMoveResult {
    /** `false` when the call stopped at its page budget: call again to continue. */
    done: boolean;
    tables: AuthMoveTableReport[];
}

/** The worker-side move between the un-pinned and the pinned auth object. */
interface AuthJurisdictionMove {
    /**
     * Copy every table from the un-pinned object into the pinned one. Refuses a pinned
     * object that already has users, unless `force` is set; a run the target has
     * already started is a resume, not a refusal.
     */
    copy: (options?: { force?: boolean }) => Promise<AuthMoveResult>;

    /**
     * Drop every table in the un-pinned object. Refused until a copy has finished,
     * with every source table recorded as fully written in the pinned object.
     */
    purge: () => Promise<{ dropped: string[] }>;
}

type Row = Record<string, unknown>;

/**
 * Run synchronous SQL inside the object's transaction, so a throw part-way rolls back
 * everything before it. Chained off a resolved promise so a synchronous throw arrives
 * as the rejection the transaction rolls back on.
 */
const inTransaction = async <R>(storage: DoStorageLike, work: () => R): Promise<R> => storage.transaction(async () => Promise.resolve().then(work));

const tableNames = (storage: DoStorageLike): string[] =>
    [...storage.sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)]
        .map((row) => String(row["name"]))
        .filter((name) => !isReservedTable(name));

const columnNames = (storage: DoStorageLike, table: string): string[] =>
    [...storage.sql.exec(`SELECT name FROM pragma_table_info(?)`, table)].map((row) => String(row["name"]));

const countRows = (storage: DoStorageLike, table: string): number =>
    Number([...storage.sql.exec(`SELECT count(*) AS n FROM ${quoteIdentifier(table)}`)][0]?.["n"] ?? 0);

/** Source: every table, with what the target needs to recreate it. */
const listMovableTables = (storage: DoStorageLike): MovableTable[] =>
    tableNames(storage).map((name) => {
        const definition = [...storage.sql.exec(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, name)][0]?.["sql"];
        const sql = typeof definition === "string" ? definition : "";
        const indexes = [...storage.sql.exec(`SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`, name)].map((row) =>
            String(row["sql"]),
        );

        return { columns: columnNames(storage, name), indexes, name, rows: countRows(storage, name), sql };
    });

const assertKnownTable = (storage: DoStorageLike, table: unknown): string => {
    if (typeof table !== "string" || !tableNames(storage).includes(table)) {
        throw new TypeError(`unknown table ${JSON.stringify(table)}`);
    }

    return table;
};

/** Source: up to `limit` rows after `after`, in `rowid` order. */
const readPage = (storage: DoStorageLike, table: string, after: number, limit: number): { last: number | undefined; rows: Row[] } => {
    const rows = [
        ...storage.sql.exec(`SELECT rowid AS "__lunora_rowid__", * FROM ${quoteIdentifier(table)} WHERE rowid > ? ORDER BY rowid LIMIT ?`, after, limit),
    ];
    const last = rows.at(-1)?.["__lunora_rowid__"];

    return {
        last: typeof last === "number" ? last : undefined,
        rows: rows.map(({ __lunora_rowid__: _rowid, ...row }) => row),
    };
};

const markerRows = (storage: DoStorageLike): { after: number; done: boolean; table: string }[] => {
    if (columnNames(storage, MARKER_TABLE).length === 0) {
        return [];
    }

    return [...storage.sql.exec(`SELECT tbl, after, done FROM ${quoteIdentifier(MARKER_TABLE)}`)].map((row) => {
        return { after: Number(row["after"]), done: row["done"] === 1, table: String(row["tbl"]) };
    });
};

const DDL_TABLE = /^CREATE TABLE /iu;
const DDL_INDEX = /^CREATE (?:UNIQUE )?INDEX /iu;

/**
 * Refuse to copy into a pinned object that already has users, unless forced. A target
 * holding an earlier copy's progress is a resume, not a refusal: the users it has
 * came from that copy.
 */
const assertTargetEmpty = (storage: DoStorageLike, options: { force: boolean; userTable: string }): void => {
    if (options.force || markerRows(storage).length > 0 || !tableNames(storage).includes(options.userTable)) {
        return;
    }

    const users = countRows(storage, options.userTable);

    if (users > 0) {
        throw new LunoraError(
            "AUTH_MOVE_TARGET_NOT_EMPTY",
            `the pinned auth object already has ${String(users)} user(s); copying into it would merge two user bases — pass force to copy anyway`,
            { data: { users } },
        );
    }
};

/** Target: give `table` somewhere to land — create it from the source's DDL, or add the columns it lacks. */
const ensureTable = (storage: DoStorageLike, table: MovableTable, existing: Set<string>): void => {
    if (isReservedTable(table.name)) {
        throw new TypeError(`refusing reserved table ${JSON.stringify(table.name)}`);
    }

    if (existing.has(table.name)) {
        const present = new Set(columnNames(storage, table.name));

        // A column the source has and the target lacks (a plugin removed since, or an
        // older column the current schema dropped) is added untyped and nullable, so
        // the value still has somewhere to land.
        for (const column of table.columns.filter((name) => !present.has(name))) {
            [...storage.sql.exec(`ALTER TABLE ${quoteIdentifier(table.name)} ADD COLUMN ${quoteIdentifier(column)}`)];
        }

        return;
    }

    // The source's own DDL, so the table keeps its constraints. It came from this app's
    // other auth object over the secret-gated route; the prefix check keeps anything but
    // a table or index definition out regardless.
    if (!DDL_TABLE.test(table.sql) || table.indexes.some((sql) => !DDL_INDEX.test(sql))) {
        throw new TypeError(`refusing unexpected DDL for ${JSON.stringify(table.name)}`);
    }

    for (const statement of [table.sql, ...table.indexes]) {
        [...storage.sql.exec(statement)];
    }
};

/**
 * Target: prepare for a copy — refuse a populated object unless forced, create the
 * tables it lacks, add the columns it lacks, and hand back where each table resumes.
 */
const beginMove = (
    storage: DoStorageLike,
    tables: MovableTable[],
    options: { force: boolean; userTable: string },
): { cursors: Record<string, number>; targetRows: Record<string, number> } => {
    assertTargetEmpty(storage, options);

    const existing = new Set(tableNames(storage));

    [
        ...storage.sql.exec(
            `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(MARKER_TABLE)} (tbl TEXT NOT NULL PRIMARY KEY, after INTEGER NOT NULL, done INTEGER NOT NULL)`,
        ),
    ];

    for (const table of tables) {
        ensureTable(storage, table, existing);
        [...storage.sql.exec(`INSERT INTO ${quoteIdentifier(MARKER_TABLE)} (tbl, after, done) VALUES (?, 0, 0) ON CONFLICT DO NOTHING`, table.name)];
    }

    const cursors = Object.fromEntries(markerRows(storage).map(({ after, table }) => [table, after]));
    const targetRows = Object.fromEntries(tables.map(({ name }) => [name, countRows(storage, name)]));

    return { cursors, targetRows };
};

/** Target: write one page and advance the table's cursor, atomically. */
const writePage = async (storage: DoStorageLike, table: string, rows: Row[], last: number): Promise<{ inserted: number }> => {
    if (!markerRows(storage).some((marker) => marker.table === table)) {
        throw new TypeError(`table ${JSON.stringify(table)} was not part of this move`);
    }

    return inTransaction(storage, () => {
        let inserted = 0;

        for (const row of rows) {
            const columns = Object.keys(row);

            [
                ...storage.sql.exec(
                    `INSERT INTO ${quoteIdentifier(table)} (${columns.map((column) => quoteIdentifier(column)).join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ON CONFLICT DO NOTHING`,
                    ...columns.map((column) => row[column]),
                ),
            ];
            // `changes()` rather than counting the table around the page: a count is a
            // full scan, and one per page makes a large copy quadratic.
            inserted += Number([...storage.sql.exec(`SELECT changes() AS n`)][0]?.["n"] ?? 0);
        }

        [...storage.sql.exec(`UPDATE ${quoteIdentifier(MARKER_TABLE)} SET after = ? WHERE tbl = ?`, last, table)];

        return { inserted };
    });
};

/**
 * Serve one half of the move inside an auth object. `userTable` is the physical name
 * of better-auth's `user` table, for the "already has users" refusal; `prepare`
 * materialises the object's own schema before a copy writes into it.
 */
const handleMoveRequest = async (storage: DoStorageLike, body: Row, context: { prepare: () => void; userTable: () => string }): Promise<unknown> => {
    switch (body["op"]) {
        case "begin": {
            context.prepare();

            return beginMove(storage, body["tables"] as MovableTable[], { force: body["force"] === true, userTable: context.userTable() });
        }
        case "finish": {
            [...storage.sql.exec(`UPDATE ${quoteIdentifier(MARKER_TABLE)} SET done = 1`)];

            return {};
        }
        case "manifest": {
            return { tables: listMovableTables(storage) };
        }
        case "page": {
            const page = readPage(
                storage,
                assertKnownTable(storage, body["table"]),
                Number(body["after"] ?? 0),
                Math.min(Number(body["limit"] ?? PAGE_ROWS), PAGE_ROWS),
            );

            return { last: page.last, rows: encodeWire(page.rows) };
        }
        case "purge": {
            const copiedTo = body["copiedTo"] as Record<string, number>;
            const dropped = tableNames(storage);

            await inTransaction(storage, () => {
                // Checked inside the transaction that drops, so no row can land between
                // the check and the drop. A row past the copied cursor (or a table the
                // copy never saw) would be lost: refuse, and let the copy pick it up.
                const uncopied = dropped.filter((table) => {
                    const after = copiedTo[table];

                    return after === undefined || [...storage.sql.exec(`SELECT 1 FROM ${quoteIdentifier(table)} WHERE rowid > ? LIMIT 1`, after)].length > 0;
                });

                if (uncopied.length > 0) {
                    throw new LunoraError(
                        "AUTH_MOVE_INCOMPLETE",
                        `refusing to purge the un-pinned auth object: ${uncopied.join(", ")} gained rows the copy has not written — run the copy again first`,
                        { data: { unfinished: uncopied } },
                    );
                }

                for (const table of dropped) {
                    [...storage.sql.exec(`DROP TABLE ${quoteIdentifier(table)}`)];
                }
            });

            return { dropped };
        }
        case "status": {
            return { markers: markerRows(storage) };
        }
        case "write": {
            return writePage(storage, assertKnownTable(storage, body["table"]), decodeWire(body["rows"]) as Row[], Number(body["last"]));
        }
        default: {
            throw new TypeError(`unknown move op ${JSON.stringify(body["op"])}`);
        }
    }
};

/** Which object a move request goes to: the un-pinned `source` or the pinned `target`. */
type MoveSide = "source" | "target";

/**
 * The worker-side driver.
 * @param post Send one move request body to {@link MOVE_PATH} on that side's object, with the internal secret.
 */
const createAuthJurisdictionMove = (post: (side: MoveSide, body: Row) => Promise<Response>): AuthJurisdictionMove => {
    const call = async <T>(side: MoveSide, body: Row): Promise<T> => {
        const response = await post(side, body);
        const payload: T & { error?: unknown } = await response.json();

        if (!response.ok) {
            const error = (typeof payload.error === "object" && payload.error !== null ? payload.error : {}) as {
                code?: string;
                data?: unknown;
                message?: string;
            };

            throw new LunoraError(
                error.code ?? "AUTH_MOVE_FAILED",
                error.message ?? `auth move ${String(body["op"])} on the ${side} object failed (${String(response.status)})`,
                {
                    data: error.data,
                    status: response.status,
                },
            );
        }

        return payload;
    };

    return {
        copy: async (options = {}) => {
            const { tables } = await call<{ tables: MovableTable[] }>("source", { op: "manifest" });
            const begun = await call<{ cursors: Record<string, number>; targetRows: Record<string, number> }>("target", {
                force: options.force === true,
                op: "begin",
                tables,
            });
            const reports: AuthMoveTableReport[] = [];
            let pages = 0;

            for (const table of tables) {
                const report: AuthMoveTableReport = {
                    copied: 0,
                    skipped: 0,
                    sourceRows: table.rows,
                    table: table.name,
                    targetRows: begun.targetRows[table.name] ?? 0,
                };
                let after = begun.cursors[table.name] ?? 0;

                reports.push(report);

                for (;;) {
                    if (pages >= MAX_PAGES_PER_CALL) {
                        return { done: false, tables: reports };
                    }

                    pages += 1;

                    // eslint-disable-next-line no-await-in-loop -- each page starts at the previous page's cursor
                    const page = await call<{ last?: number; rows: unknown }>("source", { after, limit: PAGE_ROWS, op: "page", table: table.name });
                    const rows = decodeWire(page.rows) as Row[];

                    if (rows.length === 0 || page.last === undefined) {
                        break;
                    }

                    // eslint-disable-next-line no-await-in-loop -- the write advances the cursor the next read starts from
                    const written = await call<{ inserted: number }>("target", {
                        last: page.last,
                        op: "write",
                        rows: page.rows,
                        table: table.name,
                    });

                    report.copied += written.inserted;
                    report.skipped += rows.length - written.inserted;
                    report.targetRows += written.inserted;
                    after = page.last;

                    if (rows.length < PAGE_ROWS) {
                        break;
                    }
                }
            }

            await call("target", { op: "finish" });

            return { done: true, tables: reports };
        },
        purge: async () => {
            const { tables } = await call<{ tables: MovableTable[] }>("source", { op: "manifest" });
            const { markers } = await call<{ markers: { after: number; done: boolean; table: string }[] }>("target", { op: "status" });
            const finished = new Set(markers.filter(({ done }) => done).map(({ table }) => table));
            const unfinished = tables.map(({ name }) => name).filter((name) => !finished.has(name));

            if (unfinished.length > 0) {
                throw new LunoraError(
                    "AUTH_MOVE_INCOMPLETE",
                    `refusing to purge the un-pinned auth object: no finished copy of ${unfinished.join(", ")} in the pinned one — run the copy to done: true first`,
                    { data: { unfinished } },
                );
            }

            const copiedTo = Object.fromEntries(markers.filter(({ done }) => done).map(({ after, table }) => [table, after]));

            return call<{ dropped: string[] }>("source", { copiedTo, op: "purge" });
        },
    };
};

export type { AuthJurisdictionMove, AuthMoveResult, AuthMoveTableReport, MoveSide };
export { createAuthJurisdictionMove, handleMoveRequest, MARKER_TABLE, MAX_PAGES_PER_CALL, MOVE_PATH, PAGE_ROWS };
