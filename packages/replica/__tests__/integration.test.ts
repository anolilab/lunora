import { describe, expect, it, vi } from "vitest";

import type { SqliteAdapter } from "../src/index";
import { applyDiffsToDb, applyDiffToDb, createTableDiff, LocalMirror, subscribeToMirror } from "../src/index";
import type { SubscriptionClient } from "../src/subscribe-mirror";

// ─── In-memory SqliteAdapter for testing ────────────────────────────────

type Row = Record<string, unknown>;

/**
 * Lightweight in-memory SqliteAdapter that tracks tables and rows but does
 * NOT parse arbitrary SQL. It recognises the specific patterns emitted by
 * the diff-applier and local-mirror modules so integration tests can run
 * without loading sql.js (which is a browser/RN peer dependency).
 */
const createTestAdapter = (): SqliteAdapter => {
    const tables = new Map<string, Map<string, Row>>();
    let lastId = 0;

    /** Extract an unquoted table name from SQL that may use backtick quoting. */
    const tableName = (sql: string): string | undefined => {
        // Strip backticks first so the regex only sees plain identifiers
        const plain = sql.replaceAll("`", "");
        const m = plain.match(/(?:FROM|INTO|TABLE|UPDATE)\s+(?:IF NOT EXISTS\s+)?(\w+)/i);
        return m?.[1];
    };

    /** Return the column names in a parenthesised list. */
    const colNames = (sql: string): string[] => {
        const plain = sql.replaceAll("`", "");
        const m = plain.match(/\(([^)]+)\)\s*(?:VALUES|SELECT|$)/i);
        if (!m) {
            return [];
        }
        return m[1]!.split(",").map((c) => c.trim());
    };

    return {
        exec(sql: string, params?: ReadonlyArray<unknown>): void {
            const plain = sql.replaceAll("`", "");
            const upper = plain.trim().toUpperCase();

            if (upper.startsWith("CREATE TABLE")) {
                const name = tableName(sql);
                if (name && !tables.has(name)) {
                    tables.set(name, new Map());
                }
            } else if (upper.startsWith("INSERT")) {
                const name = tableName(sql);
                if (!name) {
                    return;
                }
                const t = tables.get(name);
                if (!t) {
                    return;
                }

                if (params && params.length > 0) {
                    // Parameterised INSERT
                    const cols = colNames(sql);
                    const row: Row = {};
                    for (let i = 0; i < cols.length && i < params.length; i += 1) {
                        row[cols[i]!] = params[i];
                    }
                    row["id"] ??= String((lastId += 1));
                    t.set(String(row["id"]), row);
                } else {
                    // Inline VALUES — parse from the SQL text
                    // This handles `VALUES ('1', 'alice', 30)` style.
                    // For simplicity we skip — use parameterised INSERTs in test setup.
                }
            } else if (upper.startsWith("UPDATE")) {
                const name = tableName(sql);
                const t = name ? tables.get(name) : undefined;
                if (!t || !params) {
                    return;
                }

                const setM = plain.match(/SET\s+(.+?)(?:WHERE|$)/is);
                const whereM = plain.match(/WHERE\s+(.+)$/is);
                const whereVal = whereM ? params[params.length - 1] : undefined;

                if (setM) {
                    const setCols = setM[1]!.split(",").map((s) => s.trim().split("=")[0]!.trim());
                    for (const [id, row] of t) {
                        if (whereVal !== undefined && row["id"] !== whereVal) {
                            continue;
                        }
                        const updated = { ...row };
                        for (let i = 0; i < setCols.length && i < params.length; i += 1) {
                            updated[setCols[i]!] = params[i]!;
                        }
                        t.set(id, updated);
                    }
                }
            } else if (upper.startsWith("DELETE")) {
                const name = tableName(sql);
                const t = name ? tables.get(name) : undefined;
                if (!t) {
                    return;
                }
                const whereM = plain.match(/WHERE\s+(.+)$/i);
                if (whereM && params?.[0] !== undefined) {
                    for (const [id, row] of t) {
                        if (row["id"] === params[0]) {
                            t.delete(id);
                        }
                    }
                } else {
                    t.clear();
                }
            }
        },

        query<T = Row>(_sql: string, params?: ReadonlyArray<unknown>): T[] {
            const plain = _sql.replaceAll("`", "");

            // Handle sqlite_master (meta-queries from LocalMirror)
            if (/sqlite_master/i.test(plain)) {
                let result = [...tables.keys()].map((k) => {
                    return { name: k };
                });
                // Filter by name=? — handles `WHERE type='table' AND name=?`
                const nameIdx = plain.indexOf("name=?");
                if (nameIdx !== -1 && params && params.length > 0) {
                    result = result.filter((r) => r.name === params[0]);
                }
                return result as T[];
            }

            const name = tableName(_sql);
            const t = name ? tables.get(name) : undefined;
            if (!t) {
                return [];
            }

            let rows = [...t.values()];
            const whereM = plain.match(/WHERE\s+(.+?)(?:ORDER BY|LIMIT|$)/is);
            if (whereM && params && params.length > 0) {
                rows = rows.filter((r) => r["id"] === params[0]);
            }
            return rows as T[];
        },

        transaction(fn: () => void): void {
            fn();
        },

        lastInsertRowId(): number {
            return lastId;
        },

        close(): void {
            // No-op: the Map data persists in memory so the adapter can be
            // reused across LocalMirror restarts, simulating a persisted DB.
        },
    };
};

// ─── Diff → adapter application ─────────────────────────────────────────

describe(applyDiffToDb, () => {
    it("inserts rows", () => {
        const adapter = createTestAdapter();
        adapter.exec("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)");

        applyDiffToDb(adapter, createTableDiff("users", [{ type: "insert", data: { id: "1", name: "alice" } }]));

        const rows = adapter.query("SELECT * FROM users WHERE id = ?", ["1"]);

        expect(rows).toHaveLength(1);
        expect(rows[0]!.name).toBe("alice");
    });

    it("updates rows", () => {
        const adapter = createTestAdapter();
        adapter.exec("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, age INTEGER)");
        // Use parameterised INSERT — the mock does not parse inline VALUES
        adapter.exec("INSERT INTO users (id, name, age) VALUES (?, ?, ?)", ["1", "alice", 30]);

        applyDiffToDb(adapter, createTableDiff("users", [{ type: "update", id: "1", data: { age: 31 } }]));

        const rows = adapter.query("SELECT * FROM users WHERE id = ?", ["1"]);

        expect(rows[0]!.age).toBe(31);
        expect(rows[0]!.name).toBe("alice");
    });

    it("deletes rows", () => {
        const adapter = createTestAdapter();
        adapter.exec("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)");
        adapter.exec("INSERT INTO users (id, name) VALUES (?, ?)", ["1", "alice"]);

        applyDiffToDb(adapter, createTableDiff("users", [{ type: "delete", id: "1" }]));

        const rows = adapter.query("SELECT * FROM users WHERE id = ?", ["1"]);

        expect(rows).toHaveLength(0);
    });

    it("handles mixed batch", () => {
        const adapter = createTestAdapter();
        adapter.exec("CREATE TABLE items (id TEXT PRIMARY KEY, val TEXT)");
        adapter.exec("INSERT INTO items (id, val) VALUES (?, ?)", ["keep", "stay"]);

        applyDiffToDb(
            adapter,
            createTableDiff("items", [
                { type: "insert", data: { id: "new", val: "hello" } },
                { type: "update", id: "keep", data: { val: "updated" } },
                { type: "delete", id: "old" },
            ]),
        );

        const rows = adapter.query("SELECT * FROM items");

        expect(rows).toHaveLength(2);
        expect(rows.find((r: Row) => r.id === "new")?.val).toBe("hello");
        expect(rows.find((r: Row) => r.id === "keep")?.val).toBe("updated");
    });
});

describe(applyDiffsToDb, () => {
    it("applies diffs across tables in order", () => {
        const adapter = createTestAdapter();
        adapter.exec("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)");
        adapter.exec("CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT)");

        applyDiffsToDb(adapter, [
            createTableDiff("users", [{ type: "insert", data: { id: "u1", name: "alice" } }]),
            createTableDiff("posts", [{ type: "insert", data: { id: "p1", title: "Hello" } }]),
            createTableDiff("users", [{ type: "update", id: "u1", data: { name: "alice-edit" } }]),
        ]);

        const users = adapter.query("SELECT * FROM users");

        expect(users).toHaveLength(1);
        expect(users[0]!.name).toBe("alice-edit");

        const posts = adapter.query("SELECT * FROM posts");

        expect(posts).toHaveLength(1);
        expect(posts[0]!.title).toBe("Hello");
    });
});

// ─── LocalMirror (full lifecycle) ───────────────────────────────────────

describe(LocalMirror, () => {
    it("creates meta table on construction", () => {
        const adapter = createTestAdapter();

        // Constructed for its side effect (meta-table creation); the instance
        // itself isn't used.
        new LocalMirror({ db: adapter, tables: {} });

        const tables = adapter.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
        const names = tables.map((r: Row) => r.name as string);

        expect(names).toContain("__lunora_mirror_meta");
    });

    it("applies diffs and notifies onChange", () => {
        const adapter = createTestAdapter();
        adapter.exec("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)");

        const mirror = new LocalMirror({ db: adapter, tables: { users: { primaryKey: "id" } } });
        const onChange = vi.fn();
        mirror.onChange(onChange);

        mirror.applyDiff(
            createTableDiff("users", [
                { type: "insert", data: { id: "1", name: "alice" } },
                { type: "insert", data: { id: "2", name: "bob" } },
            ]),
        );

        const rows = adapter.query("SELECT * FROM users");

        expect(rows).toHaveLength(2);
        expect(onChange).toHaveBeenCalledTimes(1);

        mirror.applyDiff(createTableDiff("users", [{ type: "update", id: "1", data: { name: "alice-edit" } }]));

        const updated = adapter.query("SELECT * FROM users WHERE id = ?", ["1"]);

        expect(updated[0]!.name).toBe("alice-edit");
        expect(onChange).toHaveBeenCalledTimes(2);
    });

    it("tracks diffs in event log", () => {
        const adapter = createTestAdapter();
        adapter.exec("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)");

        const mirror = new LocalMirror({ db: adapter, tables: { users: { primaryKey: "id" } } });

        mirror.applyDiff(createTableDiff("users", [{ type: "insert", data: { id: "1", name: "alice" } }]));

        expect(mirror.eventLog.size).toBe(1);
        expect(mirror.eventLog.nextSeq).toBe(1);

        const entries = mirror.eventLog.getSince(0);

        expect(entries[0]!.type).toBe("table-diff");
        expect(entries[0]!.tableDiffs).toHaveLength(1);
    });

    it("preserves data after restart via same adapter", () => {
        const adapter = createTestAdapter();
        adapter.exec("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)");

        const m1 = new LocalMirror({ db: adapter, tables: { users: { primaryKey: "id" } } });
        m1.applyDiff(
            createTableDiff("users", [
                { type: "insert", data: { id: "1", name: "alice" } },
                { type: "insert", data: { id: "2", name: "bob" } },
            ]),
        );
        m1.close();

        // Re-open over the same adapter to prove data survives; the instance
        // itself isn't used — we read straight from the adapter.
        new LocalMirror({ db: adapter, tables: { users: { primaryKey: "id" } } });
        const rows = adapter.query("SELECT * FROM users");

        expect(rows).toHaveLength(2);
        expect(rows.find((r: Row) => r.id === "1")?.name).toBe("alice");
    });

    it("mirror.query returns data from the db", () => {
        const adapter = createTestAdapter();
        adapter.exec("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)");

        const mirror = new LocalMirror({ db: adapter, tables: { users: { primaryKey: "id" } } });
        mirror.applyDiff(createTableDiff("users", [{ type: "insert", data: { id: "1", name: "alice" } }]));

        const result = mirror.query("SELECT * FROM users WHERE id = ?", ["1"]);

        expect(result).toHaveLength(1);
        expect(result[0]!.name).toBe("alice");
    });
});

// ─── subscribeToMirror ─────────────────────────────────────────────────

describe(subscribeToMirror, () => {
    it("forwards subscription to the client", () => {
        const adapter = createTestAdapter();
        const mirror = new LocalMirror({ db: adapter, tables: { messages: { primaryKey: "id" } } });

        const subscribeCalls: { args: unknown; ref: string }[] = [];
        const unsub = vi.fn();

        const client: SubscriptionClient = {
            subscribe(functionRef: { __lunoraRef: string }, args: Record<string, unknown>, _cb: (data: unknown) => void) {
                subscribeCalls.push({ ref: functionRef.__lunoraRef, args });
                return unsub;
            },
        };

        const cleanup = subscribeToMirror(client, mirror, { __lunoraRef: "messages.list" }, { limit: 10 });

        expect(subscribeCalls).toHaveLength(1);
        expect(subscribeCalls[0]!.ref).toBe("messages.list");

        cleanup();
    });

    it("applies diffs from subscription callback", () => {
        const adapter = createTestAdapter();
        const mirror = new LocalMirror({ db: adapter, tables: { messages: { primaryKey: "id" } } });

        let registeredCallback: ((data: unknown) => void) | undefined;

        const client: SubscriptionClient = {
            subscribe(_fn: { __lunoraRef: string }, _args: Record<string, unknown>, cb: (data: unknown) => void) {
                registeredCallback = cb;
                return vi.fn();
            },
        };

        subscribeToMirror(client, mirror, { __lunoraRef: "messages.sync" }, { room: "general" });

        if (registeredCallback) {
            registeredCallback([{ id: "1", text: "hello" }]);
        }

        const rows = adapter.query("SELECT * FROM fn_messages_sync WHERE id = ?", ["1"]);

        expect(rows).toHaveLength(1);
        expect(rows[0]!.text).toBe("hello");
    });

    it("cleanup unsubs the client subscription", () => {
        const adapter = createTestAdapter();
        const mirror = new LocalMirror({ db: adapter, tables: { t: { primaryKey: "id" } } });

        const unsub = vi.fn();
        const client: SubscriptionClient = {
            subscribe(_fn: { __lunoraRef: string }, _args: Record<string, unknown>, _cb: (data: unknown) => void) {
                return unsub;
            },
        };

        const cleanup = subscribeToMirror(client, mirror, { __lunoraRef: "q1" }, {});
        cleanup();

        expect(unsub).toHaveBeenCalledTimes(1);
    });
});
