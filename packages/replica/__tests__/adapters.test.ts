import Database from "better-sqlite3";
import initSqlJs from "sql.js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { createBetterSqlite3Adapter } from "../src/adapters/better-sqlite3";
import { createSqliteWasmAdapter } from "../src/adapters/sqlite-wasm";
import { createSqlJsAdapter } from "../src/adapters/sqljs";
import type { SqliteAdapter } from "../src/adapters/types";
import { LocalMirror } from "../src/local-mirror";
import { createTableDiff } from "../src/table-diff";

// ── Real-engine fixtures ────────────────────────────────────────────────
//
// The integration suite exercises LocalMirror against a hand-rolled fake that
// pattern-matches SQL strings. These tests run the SAME public surface against
// the two real engines the adapters ship for — sql.js (WASM SQLite) and
// better-sqlite3 (native Node binding) — so the generated SQL is actually
// parsed, bound, and executed by SQLite.

let SQL: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
    SQL = await initSqlJs();
});

const makeSqlJs = (): SqliteAdapter => createSqlJsAdapter(new SQL.Database());
const makeBetterSqlite3 = (): SqliteAdapter => createBetterSqlite3Adapter(new Database(":memory:"));

/**
 * The official `@sqlite.org/sqlite-wasm` bundle cannot initialise in plain Node
 * (`self is not defined` outside a browser/worker global), so the wasm adapter
 * runs against a structural double instead.
 *
 * REPLICA-01 STOP: this fixture matches the DOCUMENTED real `oo1.DB` wire
 * shape — `exec({ returnValue: "resultRows", rowMode: "object" })` returns
 * rows directly (`Record&lt;string, unknown>[]`, NOT sql.js's
 * `{ columns, values }[]`), and `selectValue()` returns a single scalar — but
 * it is backed by a REAL sql.js engine underneath (every statement is still
 * parsed/executed by real SQLite), with a thin re-shaping layer translating
 * sql.js's native result shape into the oo1 shape. This closes the adapter's
 * API-SHAPE gap the bug was about, but — since the real driver could not be
 * installed/initialised in this Node test environment — it is NOT a
 * substitute for an integration test against the actual
 * `@sqlite.org/sqlite-wasm` package.
 */
const makeSqliteWasm = (): SqliteAdapter => {
    const engine = new SQL.Database();

    const toRowObjects = (result: { columns: string[]; values: unknown[][] }[]): Record<string, unknown>[] => {
        const first = result[0];

        if (!first) {
            return [];
        }

        return first.values.map((row) => {
            const object: Record<string, unknown> = {};

            for (const [i, column] of first.columns.entries()) {
                object[column] = row[i];
            }

            return object;
        });
    };

    return createSqliteWasmAdapter({
        close: () => {
            engine.close();
        },
        exec: (sql, options) => {
            if (options?.returnValue === "resultRows" && options.rowMode === "object") {
                return toRowObjects(engine.exec(sql, options.bind));
            }

            engine.run(sql, options?.bind);

            return undefined;
        },
        selectValue: (sql, bind) => {
            const result = engine.exec(sql, bind);
            const first = result[0];

            return first?.values[0]?.[0];
        },
    });
};

/** All engines must satisfy the same adapter contract. */
const engines: [name: string, make: () => SqliteAdapter][] = [
    ["sql.js", makeSqlJs],
    ["better-sqlite3", makeBetterSqlite3],
    ["sqlite-wasm", makeSqliteWasm],
];

describe.each(engines)("sqliteAdapter contract (%s)", (_name, makeAdapter) => {
    it("executes DDL and parameterised DML, then reads rows back", () => {
        const database = makeAdapter();

        database.exec("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, age INTEGER)");
        database.exec("INSERT INTO users (id, name, age) VALUES (?, ?, ?)", ["u1", "alice", 30]);
        database.exec("INSERT INTO users (id, name, age) VALUES (?, ?, ?)", ["u2", "bob", 25]);

        const rows = database.query<{ age: number; id: string; name: string }>("SELECT id, name, age FROM users ORDER BY id");

        expect(rows).toStrictEqual([
            { age: 30, id: "u1", name: "alice" },
            { age: 25, id: "u2", name: "bob" },
        ]);
    });

    it("binds query parameters", () => {
        const database = makeAdapter();

        database.exec("CREATE TABLE t (id TEXT PRIMARY KEY, v INTEGER)");
        database.exec("INSERT INTO t (id, v) VALUES (?, ?)", ["a", 1]);
        database.exec("INSERT INTO t (id, v) VALUES (?, ?)", ["b", 2]);

        const rows = database.query<{ id: string }>("SELECT id FROM t WHERE v > ?", [1]);

        expect(rows).toStrictEqual([{ id: "b" }]);
    });

    it("returns an empty array for a query with no matches", () => {
        const database = makeAdapter();

        database.exec("CREATE TABLE empty_t (id TEXT PRIMARY KEY)");

        expect(database.query("SELECT * FROM empty_t")).toStrictEqual([]);
    });

    it("commits a successful transaction", () => {
        const database = makeAdapter();

        database.exec("CREATE TABLE t (id TEXT PRIMARY KEY)");

        database.transaction(() => {
            database.exec("INSERT INTO t (id) VALUES (?)", ["a"]);
            database.exec("INSERT INTO t (id) VALUES (?)", ["b"]);
        });

        expect(database.query("SELECT id FROM t")).toHaveLength(2);
    });

    it("rolls the whole transaction back when the callback throws", () => {
        const database = makeAdapter();

        database.exec("CREATE TABLE t (id TEXT PRIMARY KEY)");

        expect(() => {
            database.transaction(() => {
                database.exec("INSERT INTO t (id) VALUES (?)", ["a"]);

                throw new Error("abort tx");
            });
        }).toThrow("abort tx");

        // The insert before the throw must not survive.
        expect(database.query("SELECT id FROM t")).toStrictEqual([]);
    });

    it("reports the last inserted rowid", () => {
        const database = makeAdapter();

        database.exec("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)");
        database.exec("INSERT INTO t (v) VALUES (?)", ["first"]);

        expect(database.lastInsertRowId()).toBe(1);

        database.exec("INSERT INTO t (v) VALUES (?)", ["second"]);

        expect(database.lastInsertRowId()).toBe(2);
    });
});

// ── LocalMirror on real engines ─────────────────────────────────────────

describe.each(engines)("localMirror end-to-end (%s)", (_name, makeAdapter) => {
    it("creates the table from the first diff and applies insert/update/delete", () => {
        const mirror = new LocalMirror({ db: makeAdapter() });

        mirror.applyDiff(
            createTableDiff("todos", [
                { data: { id: "1", title: "write tests" }, type: "insert" },
                { data: { id: "2", title: "ship it" }, type: "insert" },
            ]),
        );

        expect(mirror.query("SELECT id, title FROM todos ORDER BY id")).toStrictEqual([
            { id: "1", title: "write tests" },
            { id: "2", title: "ship it" },
        ]);

        mirror.applyDiff(
            createTableDiff("todos", [
                { data: { title: "ship it now" }, id: "2", type: "update" },
                { id: "1", type: "delete" },
            ]),
        );

        expect(mirror.query("SELECT id, title FROM todos")).toStrictEqual([{ id: "2", title: "ship it now" }]);
    });

    it("re-inserting the same primary key replaces the row (INSERT OR REPLACE)", () => {
        const mirror = new LocalMirror({ db: makeAdapter() });

        mirror.applyDiff(createTableDiff("todos", [{ data: { id: "1", title: "v1" }, type: "insert" }]));
        mirror.applyDiff(createTableDiff("todos", [{ data: { id: "1", title: "v2" }, type: "insert" }]));

        expect(mirror.query("SELECT id, title FROM todos")).toStrictEqual([{ id: "1", title: "v2" }]);
    });

    it("evolves the schema when a later diff carries new columns", () => {
        const mirror = new LocalMirror({ db: makeAdapter() });

        mirror.applyDiff(createTableDiff("todos", [{ data: { id: "1", title: "old row" }, type: "insert" }]));
        // A second diff introduces a column the table does not have yet.
        mirror.applyDiff(createTableDiff("todos", [{ data: { done: "yes", id: "2", title: "new row" }, type: "insert" }]));

        expect(mirror.query("SELECT id, done FROM todos ORDER BY id")).toStrictEqual([
            { done: null, id: "1" },
            { done: "yes", id: "2" },
        ]);
    });

    it("honours a custom primary key from the table registry", () => {
        const mirror = new LocalMirror({ db: makeAdapter(), tables: { notes: { primaryKey: "noteId" } } });

        mirror.applyDiff(
            createTableDiff("notes", [
                { data: { body: "a", noteId: "n1" }, type: "insert" },
                { data: { body: "b", noteId: "n2" }, type: "insert" },
            ]),
        );
        mirror.applyDiff(createTableDiff("notes", [{ id: "n1", type: "delete" }]));

        expect(mirror.query("SELECT noteId FROM notes")).toStrictEqual([{ noteId: "n2" }]);
    });

    it("records every applied diff in the event log", () => {
        const mirror = new LocalMirror({ db: makeAdapter() });
        const diff = createTableDiff("todos", [{ data: { id: "1" }, type: "insert" }]);

        mirror.applyDiff(diff);

        expect(mirror.eventLog.size).toBe(1);

        const [entry] = mirror.eventLog.getSince(0);

        expect(entry?.type).toBe("table-diff");
        expect(entry?.payload).toStrictEqual(diff);
    });

    it("skips empty diffs entirely — no event, no notification", () => {
        const mirror = new LocalMirror({ db: makeAdapter() });
        const listener = vi.fn();

        mirror.onChange(listener);
        mirror.applyDiff(createTableDiff("todos", []));

        expect(mirror.eventLog.size).toBe(0);
        expect(listener).not.toHaveBeenCalled();
    });

    it("notifies onChange subscribers and survives a throwing listener", () => {
        const mirror = new LocalMirror({ db: makeAdapter() });
        const calls: string[] = [];

        mirror.onChange(() => {
            throw new Error("bad listener");
        });

        const unsubscribe = mirror.onChange(() => calls.push("second"));

        mirror.applyDiff(createTableDiff("todos", [{ data: { id: "1" }, type: "insert" }]));

        expect(calls).toStrictEqual(["second"]);

        unsubscribe();
        mirror.applyDiff(createTableDiff("todos", [{ data: { id: "2" }, type: "insert" }]));

        expect(calls).toStrictEqual(["second"]);
    });

    it("clearData wipes rows but preserves schema and the event log", () => {
        const mirror = new LocalMirror({ db: makeAdapter() });

        mirror.applyDiff(createTableDiff("todos", [{ data: { id: "1", title: "t" }, type: "insert" }]));
        mirror.applyDiff(createTableDiff("users", [{ data: { id: "u1", name: "alice" }, type: "insert" }]));

        mirror.clearData();

        expect(mirror.query("SELECT * FROM todos")).toStrictEqual([]);
        expect(mirror.query("SELECT * FROM users")).toStrictEqual([]);
        // Schema survives — a fresh diff applies without re-creating the table.
        expect(mirror.eventLog.size).toBe(2);

        mirror.applyDiff(createTableDiff("todos", [{ data: { id: "9", title: "after clear" }, type: "insert" }]));

        expect(mirror.query("SELECT id FROM todos")).toStrictEqual([{ id: "9" }]);
    });

    // REPLICA-09: clearData must notify subscribers and bump a version
    // independent of eventLog.size (which clearData never grows).
    it("clearData notifies onChange subscribers and bumps mirror.version without growing the event log", () => {
        const mirror = new LocalMirror({ db: makeAdapter() });

        mirror.applyDiff(createTableDiff("todos", [{ data: { id: "1" }, type: "insert" }]));

        const versionAfterApply = mirror.version;
        const eventLogSizeAfterApply = mirror.eventLog.size;

        const listener = vi.fn();

        mirror.onChange(listener);
        mirror.clearData();

        expect(listener).toHaveBeenCalledTimes(1);
        expect(mirror.version).toBeGreaterThan(versionAfterApply);
        expect(mirror.eventLog.size).toBe(eventLogSizeAfterApply);
    });

    // REPLICA-09: an unescaped `_` in the `__lunora_%` / `sqlite_%` LIKE
    // patterns is a wildcard, so a table that merely CONTAINS "lunora" at the
    // right offset (not one of the reserved internal tables) was wrongly
    // excluded from clearData. With the pattern escaped, only the literal
    // reserved-prefix tables are skipped.
    it("clearData does not wrongly skip tables that merely contain 'lunora' via the LIKE wildcard bug", () => {
        const mirror = new LocalMirror({ db: makeAdapter() });

        mirror.applyDiff(createTableDiff("AAlunoraZextra", [{ data: { id: "1" }, type: "insert" }]));

        mirror.clearData();

        expect(mirror.query("SELECT * FROM AAlunoraZextra")).toStrictEqual([]);
    });

    it("registerTable and mirroredTables reflect the registry", () => {
        const mirror = new LocalMirror({ db: makeAdapter(), tables: { one: {} } });

        expect(mirror.mirroredTables).toStrictEqual(["one"]);

        mirror.registerTable("two", { primaryKey: "key" });

        expect(mirror.mirroredTables).toStrictEqual(["one", "two"]);
    });

    it("close disposes the connection and clears the event log", () => {
        const mirror = new LocalMirror({ db: makeAdapter() });

        mirror.applyDiff(createTableDiff("todos", [{ data: { id: "1" }, type: "insert" }]));
        mirror.close();

        expect(mirror.eventLog.size).toBe(0);
        expect(() => mirror.query("SELECT 1 AS one")).toThrow();
    });

    // REPLICA-06: maxEventLogEntries bounds the mirror's internal event log
    // — a long run of applied diffs does not grow it unboundedly.
    it("maxEventLogEntries caps the mirror's event log over a long run", () => {
        const mirror = new LocalMirror({ db: makeAdapter(), maxEventLogEntries: 5 });

        for (let index = 0; index < 50; index += 1) {
            mirror.applyDiff(createTableDiff("todos", [{ data: { id: String(index) }, type: "insert" }]));
        }

        expect(mirror.eventLog.size).toBe(5);
        // The mirrored rows themselves are unaffected by the log cap.
        expect(mirror.query("SELECT id FROM todos")).toHaveLength(50);
    });
});

describe(createSqliteWasmAdapter, () => {
    it("falls back to -1 when the engine returns no rowid result", () => {
        const adapter = createSqliteWasmAdapter({
            close: () => undefined,
            exec: () => undefined,
            selectValue: () => undefined,
        });

        expect(adapter.lastInsertRowId()).toBe(-1);
    });

    it("returns a bigint rowid as a number", () => {
        const adapter = createSqliteWasmAdapter({
            close: () => undefined,
            exec: () => undefined,
            selectValue: () => 42n,
        });

        expect(adapter.lastInsertRowId()).toBe(42);
    });
});

// ── sql.js-only surface ─────────────────────────────────────────────────

describe("localMirror.create (sql.js factory)", () => {
    it("wraps a raw sql.js database without manual adapter wiring", () => {
        const mirror = LocalMirror.create(new SQL.Database(), { tables: { todos: { primaryKey: "id" } } });

        mirror.applyDiff(createTableDiff("todos", [{ data: { id: "1", title: "from factory" }, type: "insert" }]));

        expect(mirror.query("SELECT id, title FROM todos")).toStrictEqual([{ id: "1", title: "from factory" }]);
        expect(mirror.mirroredTables).toStrictEqual(["todos"]);
    });
});
