import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { D1DatabaseLike, D1PreparedStatementLike } from "../src/d1-client";
import { MigrationRunner } from "../src/migration-runner";

interface FakeDatabase extends D1DatabaseLike {
    appliedHashes: string[];
    executed: { binds: unknown[]; sql: string }[];
}

// Matchers hoisted to module scope (avoids per-call regex recompilation).
const TRACKING_INSERT_HASH_RE = /VALUES \('([0-9a-f]{64})'/u;
const DUPLICATE_VERSION_RE = /Duplicate migration version/;
const IDENTICAL_SQL_RE = /identical SQL/u;
const MULTI_STATEMENT_RE = /more than one SQL statement/u;

const AUDIT_TRIGGER_SQL = `CREATE TRIGGER posts_audit AFTER INSERT ON posts
BEGIN
    INSERT INTO audit (post_id, label) VALUES (NEW.id, CASE WHEN NEW.id > 0 THEN 'positive' ELSE 'other' END);
END;`;

// The same trigger with a block comment BETWEEN `CREATE` and `TRIGGER`. SQLite
// allows trivia between any two keywords, so this is one valid statement.
const COMMENTED_TRIGGER_SQL = `CREATE /* audit hook */ TRIGGER posts_audit AFTER INSERT ON posts
BEGIN
    INSERT INTO audit (post_id, label) VALUES (NEW.id, CASE WHEN NEW.id > 0 THEN 'positive' ELSE 'other' END);
END;`;

const sha256Hex = async (text: string): Promise<string> => {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);

    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const createDatabase = async (initiallyAppliedSql: string[] = []): Promise<FakeDatabase> => {
    const appliedHashes = await Promise.all(initiallyAppliedSql.map((s) => sha256Hex(s)));
    const executed: { binds: unknown[]; sql: string }[] = [];

    const makeStmt = (sql: string): D1PreparedStatementLike => {
        const binds: unknown[] = [];
        const stmt: D1PreparedStatementLike = {
            all: async () => {
                if (sql.includes("SELECT hash FROM __drizzle_migrations")) {
                    return {
                        results: appliedHashes.map((h) => {
                            return { hash: h };
                        }) as never[],
                        success: true,
                    };
                }

                return { results: [], success: true };
            },
            bind: (...values) => {
                binds.push(...values);

                return stmt;
            },
            first: async () => null,
            raw: async () => [],
            run: async () => {
                executed.push({ binds: [...binds], sql });

                // The runner inlines `hash` and `created_at` directly into the
                // tracking INSERT's `sql.raw(...)` literal (drizzle's d1 batch
                // path crashes on a SQLiteRaw carrying bound params), so there
                // are no `?` binds to snapshot here. Parse the 64-char SHA-256
                // hex hash back out of the literal so the fake can simulate
                // applied state.
                if (sql.includes("INSERT INTO") && sql.includes("__drizzle_migrations")) {
                    const match = TRACKING_INSERT_HASH_RE.exec(sql);

                    if (match) {
                        appliedHashes.push(match[1]!);
                    }
                }

                return { success: true };
            },
        };

        return stmt;
    };

    const database: FakeDatabase = {
        appliedHashes,
        batch: async (stmts) => {
            for (const stmt of stmts) {
                // eslint-disable-next-line no-await-in-loop -- fake batch applies statements in order, mirroring D1's sequential batch semantics
                await stmt.run();
            }

            return [];
        },
        executed,
        prepare: makeStmt,
        withSession: () => {
            return { getBookmark: () => null, prepare: makeStmt };
        },
    };

    return database;
};

/**
 * A {@link D1DatabaseLike} backed by a real `node:sqlite` connection. D1 is
 * SQLite, so this is the closest available engine for proving that a statement
 * the lexer lets through is one statement to the engine too — the fake above
 * only records the SQL it was handed. `batch` runs sequentially, matching D1's
 * ordered batch semantics closely enough for a migration.
 */
const createSqliteDatabase = (sqlite: DatabaseSync): D1DatabaseLike => {
    const prepare = (sql: string): D1PreparedStatementLike => {
        let bound: unknown[] = [];
        const stmt: D1PreparedStatementLike = {
            all: async () => {
                return { results: sqlite.prepare(sql).all(...(bound as never[])) as never[], success: true };
            },
            bind: (...values) => {
                bound = values;

                return stmt;
            },
            first: async () => null,
            raw: async () => [],
            run: async () => {
                sqlite.prepare(sql).all(...(bound as never[]));

                return { success: true };
            },
        };

        return stmt;
    };

    return {
        batch: async (stmts) => {
            for (const stmt of stmts) {
                // eslint-disable-next-line no-await-in-loop -- D1's batch applies statements in order; so does this
                await stmt.run();
            }

            return [];
        },
        prepare,
        withSession: () => {
            return { getBookmark: () => null, prepare };
        },
    };
};

describe("migrationRunner", () => {
    it("applies pending migrations in order and records them", async () => {
        expect.assertions(5);

        const database = await createDatabase();
        const runner = new MigrationRunner(database, [
            { name: "init", sql: "CREATE TABLE a (id INTEGER);", version: 1 },
            { name: "add_b", sql: "CREATE TABLE b (id INTEGER);", version: 2 },
        ]);

        const result = await runner.run();

        expect(result.applied.map((m) => m.version)).toEqual([1, 2]);
        expect(result.skipped).toEqual([]);
        expect(database.appliedHashes).toHaveLength(2);
        expect(database.executed.some((e) => e.sql.startsWith("CREATE TABLE a"))).toBe(true);
        expect(database.executed.some((e) => e.sql.startsWith("CREATE TABLE b"))).toBe(true);
    });

    it("skips already-applied migrations", async () => {
        expect.assertions(2);

        const initialSql = "CREATE TABLE a (id INTEGER);";
        const database = await createDatabase([initialSql]);
        const runner = new MigrationRunner(database, [
            { name: "init", sql: initialSql, version: 1 },
            { name: "add_b", sql: "CREATE TABLE b (id INTEGER);", version: 2 },
        ]);

        const result = await runner.run();

        expect(result.applied.map((m) => m.version)).toEqual([2]);
        expect(result.skipped.map((m) => m.version)).toEqual([1]);
    });

    it("rejects duplicate versions at construction time", async () => {
        expect.assertions(1);

        const database = await createDatabase();

        expect(
            () =>
                new MigrationRunner(database, [
                    { name: "a", sql: "CREATE TABLE x (id INTEGER);", version: 1 },
                    { name: "b", sql: "CREATE TABLE y (id INTEGER);", version: 1 },
                ]),
        ).toThrow(DUPLICATE_VERSION_RE);
    });

    it("rejects identical SQL across different versions", async () => {
        expect.assertions(1);

        const database = await createDatabase();
        const identicalSql = "CREATE TABLE shared (id INTEGER);";

        expect(
            () =>
                new MigrationRunner(database, [
                    { name: "first", sql: identicalSql, version: 1 },
                    { name: "copy_paste", sql: identicalSql, version: 2 },
                ]),
        ).toThrow(IDENTICAL_SQL_RE);
    });

    it("rejects multi-statement migration SQL", async () => {
        expect.assertions(1);

        const database = await createDatabase();
        const runner = new MigrationRunner(database, [
            {
                name: "multi",
                sql: "CREATE TABLE a (id INTEGER); CREATE TABLE b (id INTEGER);",
                version: 1,
            },
        ]);

        await expect(runner.run()).rejects.toThrow(MULTI_STATEMENT_RE);
    });

    it("permits semicolons inside string literals", async () => {
        expect.assertions(1);

        const database = await createDatabase();
        const runner = new MigrationRunner(database, [{ name: "literal", sql: "INSERT INTO config (k, v) VALUES ('label', 'a;b');", version: 1 }]);

        const result = await runner.run();

        expect(result.applied.map((m) => m.version)).toEqual([1]);
    });

    // Finding 2: a trailing comment after the terminator used to survive the
    // regex trim and reach D1 (which rejects content past the statement). The
    // body submitted must be the bare statement — no `;`, no trailing comment.
    it("strips the terminating `;` and any trailing comment from the submitted body", async () => {
        expect.assertions(2);

        const database = await createDatabase();
        const runner = new MigrationRunner(database, [{ name: "trailing_comment", sql: "SELECT 1; -- trailing comment", version: 1 }]);

        const result = await runner.run();

        expect(result.applied.map((m) => m.version)).toEqual([1]);

        const body = database.executed.find((e) => !e.sql.includes("__drizzle_migrations"));

        expect(body?.sql).toBe("SELECT 1");
    });

    // Finding 2: `SELECT 1;;` used to pass the lexer (the second `;` hit the
    // terminator branch before any guard) — now a stray second `;` is a second
    // statement.
    it("rejects a stray second `;` (`SELECT 1;;`) as multi-statement", async () => {
        expect.assertions(1);

        const database = await createDatabase();
        const runner = new MigrationRunner(database, [{ name: "double_semi", sql: "SELECT 1;;", version: 1 }]);

        await expect(runner.run()).rejects.toThrow(MULTI_STATEMENT_RE);
    });

    // Finding 2: an opening quote after the terminator used to enter string mode
    // (the string-open branch preceded the guard) and slip past validation.
    it("rejects executable content after the terminator (`SELECT 1; 'stray'`)", async () => {
        expect.assertions(1);

        const database = await createDatabase();
        const runner = new MigrationRunner(database, [{ name: "stray_string", sql: "SELECT 1; 'stray string'", version: 1 }]);

        await expect(runner.run()).rejects.toThrow(MULTI_STATEMENT_RE);
    });

    // Finding 3: two runners racing the same pending migration — the loser's
    // tracking INSERT hits UNIQUE(hash), D1 rolls its atomic batch back (body
    // included), and run() reports the migration as skipped rather than throwing
    // or double-applying.
    it("treats a concurrent UNIQUE(hash) violation on the tracking insert as already-applied", async () => {
        expect.assertions(2);

        const makeStmt = (sql: string): D1PreparedStatementLike => {
            const stmt: D1PreparedStatementLike = {
                all: async () => {
                    return { results: [] as never[], success: true };
                },
                bind: () => stmt,
                first: async () => null,
                raw: async () => [],
                run: async () => {
                    if (sql.includes("INSERT INTO") && sql.includes("__drizzle_migrations")) {
                        // A racing runner inserted this hash first.
                        throw new Error("D1_ERROR: UNIQUE constraint failed: __drizzle_migrations.hash: SQLITE_CONSTRAINT");
                    }

                    return { success: true };
                },
            };

            return stmt;
        };

        const database: D1DatabaseLike = {
            batch: async (stmts) => {
                for (const stmt of stmts) {
                    // eslint-disable-next-line no-await-in-loop -- fake batch applies statements in order, mirroring D1's sequential batch semantics
                    await stmt.run();
                }

                return [];
            },
            prepare: makeStmt,
            withSession: () => {
                return { getBookmark: () => null, prepare: makeStmt };
            },
        };

        const runner = new MigrationRunner(database, [{ name: "seed", sql: "INSERT INTO items (id) VALUES (1);", version: 1 }]);

        const result = await runner.run();

        expect(result.applied).toEqual([]);
        expect(result.skipped.map((m) => m.version)).toEqual([1]);
    });

    it("permits semicolons inside comments", async () => {
        expect.assertions(1);

        const database = await createDatabase();
        const runner = new MigrationRunner(database, [
            {
                name: "comment",
                sql: "-- multi; line; semis\nCREATE TABLE c (id INTEGER);",
                version: 1,
            },
        ]);

        const result = await runner.run();

        expect(result.applied.map((m) => m.version)).toEqual([1]);
    });

    it("sorts out-of-order migrations before applying", async () => {
        expect.assertions(2);

        const database = await createDatabase();
        const runner = new MigrationRunner(database, [
            { name: "two", sql: "CREATE TABLE two (id INTEGER);", version: 2 },
            { name: "one", sql: "CREATE TABLE one (id INTEGER);", version: 1 },
        ]);

        const result = await runner.run();

        expect(result.applied.map((m) => m.version)).toEqual([1, 2]);
        expect(database.appliedHashes).toHaveLength(2);
    });

    // A `CREATE TRIGGER` body carries its own `;`s and cannot be split across
    // migrations, so the single-statement lexer used to make triggers
    // unappliable — it read the body's first `;` as a statement boundary and
    // told the author to do the one thing SQLite makes impossible. The `CASE …
    // END` in the body is what a naive "ends at END;" rule gets wrong.
    it("applies a CREATE TRIGGER whose body contains semicolons", async () => {
        expect.assertions(2);

        const database = await createDatabase();
        const runner = new MigrationRunner(database, [{ name: "audit_trigger", sql: AUDIT_TRIGGER_SQL, version: 1 }]);

        const result = await runner.run();

        expect(result.applied.map((m) => m.version)).toEqual([1]);

        const body = database.executed.find((e) => !e.sql.includes("__drizzle_migrations"));

        expect(body?.sql).toBe(AUDIT_TRIGGER_SQL.slice(0, -1));
    });

    // The trigger relaxation must not reopen the multi-statement hole: content
    // after the trigger's closing `END;` is still a second statement.
    it("still rejects a second statement after a trigger's closing END", async () => {
        expect.assertions(1);

        const database = await createDatabase();
        const runner = new MigrationRunner(database, [{ name: "trigger_plus", sql: `${AUDIT_TRIGGER_SQL} DROP TABLE posts;`, version: 1 }]);

        await expect(runner.run()).rejects.toThrow(MULTI_STATEMENT_RE);
    });

    // The fake D1 above only records SQL; this runs the same migration through a
    // real SQLite engine, so "D1 accepts this as one statement" is proven by an
    // engine rather than by the lexer agreeing with itself.
    it("applies the trigger against a real SQLite engine and it fires", async () => {
        expect.assertions(2);

        const sqlite = new DatabaseSync(":memory:");

        try {
            sqlite.prepare("CREATE TABLE posts (id INTEGER PRIMARY KEY)").all();
            sqlite.prepare("CREATE TABLE audit (post_id INTEGER, label TEXT)").all();

            const runner = new MigrationRunner(createSqliteDatabase(sqlite), [{ name: "audit_trigger", sql: AUDIT_TRIGGER_SQL, version: 1 }]);
            const result = await runner.run();

            expect(result.applied.map((m) => m.version)).toEqual([1]);

            sqlite.prepare("INSERT INTO posts (id) VALUES (7)").all();

            expect(sqlite.prepare("SELECT post_id, label FROM audit").all()).toEqual([{ label: "positive", post_id: 7 }]);
        } finally {
            sqlite.close();
        }
    });

    // Trivia is legal between `CREATE` and `TRIGGER`, so the header probe has to
    // look past it. When it did not, the trigger stopped being recognised as a
    // trigger and its body's first `;` was read as a statement boundary — the
    // author was told to split a statement SQLite cannot have split.
    it("applies a CREATE TRIGGER with a comment between CREATE and TRIGGER", async () => {
        expect.assertions(3);

        const sqlite = new DatabaseSync(":memory:");

        try {
            sqlite.prepare("CREATE TABLE posts (id INTEGER PRIMARY KEY)").all();
            sqlite.prepare("CREATE TABLE audit (post_id INTEGER, label TEXT)").all();

            const runner = new MigrationRunner(createSqliteDatabase(sqlite), [{ name: "audit_trigger", sql: COMMENTED_TRIGGER_SQL, version: 1 }]);
            const result = await runner.run();

            expect(result.applied.map((m) => m.version)).toEqual([1]);

            sqlite.prepare("INSERT INTO posts (id) VALUES (7)").all();

            expect(sqlite.prepare("SELECT post_id, label FROM audit").all()).toEqual([{ label: "positive", post_id: 7 }]);
        } finally {
            sqlite.close();
        }

        // The relaxation must not reopen the multi-statement hole for the
        // commented spelling either.
        const database = await createDatabase();
        const plus = new MigrationRunner(database, [{ name: "trigger_plus", sql: `${COMMENTED_TRIGGER_SQL} DROP TABLE posts;`, version: 1 }]);

        await expect(plus.run()).rejects.toThrow(MULTI_STATEMENT_RE);
    });
});
