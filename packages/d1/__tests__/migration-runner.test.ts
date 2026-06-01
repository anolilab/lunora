import { describe, expect, test } from "vitest";

import type { D1DatabaseLike, D1PreparedStatementLike } from "../src/d1-client.js";
import { MigrationRunner } from "../src/migration-runner.js";

interface FakeDb extends D1DatabaseLike {
    appliedHashes: string[];
    executed: { binds: unknown[]; sql: string }[];
}

const sha256Hex = async (text: string): Promise<string> => {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);

    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const createDb = async (initiallyAppliedSql: string[] = []): Promise<FakeDb> => {
    const appliedHashes = await Promise.all(initiallyAppliedSql.map((s) => sha256Hex(s)));
    const executed: { binds: unknown[]; sql: string }[] = [];

    const makeStmt = (sql: string): D1PreparedStatementLike => {
        const binds: unknown[] = [];
        const stmt: D1PreparedStatementLike = {
            bind: (...values) => {
                binds.push(...values);

                return stmt;
            },
            first: async () => null,
            all: async () => {
                if (sql.includes("SELECT hash FROM __drizzle_migrations")) {
                    return { results: appliedHashes.map((h) => ({ hash: h })) as never[], success: true };
                }

                return { results: [], success: true };
            },
            run: async () => {
                executed.push({ sql, binds: [...binds] });

                // The runner inlines `hash` and `created_at` directly into the
                // tracking INSERT's `sql.raw(...)` literal (drizzle's d1 batch
                // path crashes on a SQLiteRaw carrying bound params), so there
                // are no `?` binds to snapshot here. Parse the 64-char SHA-256
                // hex hash back out of the literal so the fake can simulate
                // applied state.
                if (sql.includes("INSERT INTO") && sql.includes("__drizzle_migrations")) {
                    const match = /VALUES \('([0-9a-f]{64})'/u.exec(sql);

                    if (match) {
                        appliedHashes.push(match[1]!);
                    }
                }

                return { success: true };
            },
            raw: async () => [],
        };

        return stmt;
    };

    const db: FakeDb = {
        executed,
        appliedHashes,
        withSession: () => ({ prepare: makeStmt, getBookmark: () => null }),
        prepare: makeStmt,
        batch: async (stmts) => {
            for (const stmt of stmts) {
                await stmt.run();
            }

            return [];
        },
    };

    return db;
};

describe("migrationRunner", () => {
    test("applies pending migrations in order and records them", async () => {
        const db = await createDb();
        const runner = new MigrationRunner(db, [
            { version: 1, name: "init", sql: "CREATE TABLE a (id INTEGER);" },
            { version: 2, name: "add_b", sql: "CREATE TABLE b (id INTEGER);" },
        ]);

        const result = await runner.run();

        expect(result.applied.map((m) => m.version)).toEqual([1, 2]);
        expect(result.skipped).toEqual([]);
        expect(db.appliedHashes).toHaveLength(2);
        expect(db.executed.some((e) => e.sql.startsWith("CREATE TABLE a"))).toBe(true);
        expect(db.executed.some((e) => e.sql.startsWith("CREATE TABLE b"))).toBe(true);
    });

    test("skips already-applied migrations", async () => {
        const initialSql = "CREATE TABLE a (id INTEGER);";
        const db = await createDb([initialSql]);
        const runner = new MigrationRunner(db, [
            { version: 1, name: "init", sql: initialSql },
            { version: 2, name: "add_b", sql: "CREATE TABLE b (id INTEGER);" },
        ]);

        const result = await runner.run();

        expect(result.applied.map((m) => m.version)).toEqual([2]);
        expect(result.skipped.map((m) => m.version)).toEqual([1]);
    });

    test("rejects duplicate versions at construction time", async () => {
        const db = await createDb();

        expect(
            () =>
                new MigrationRunner(db, [
                    { version: 1, name: "a", sql: "CREATE TABLE x (id INTEGER);" },
                    { version: 1, name: "b", sql: "CREATE TABLE y (id INTEGER);" },
                ]),
        ).toThrow(/Duplicate migration version/);
    });

    test("rejects identical SQL across different versions", async () => {
        const db = await createDb();
        const identicalSql = "CREATE TABLE shared (id INTEGER);";

        expect(
            () =>
                new MigrationRunner(db, [
                    { version: 1, name: "first", sql: identicalSql },
                    { version: 2, name: "copy_paste", sql: identicalSql },
                ]),
        ).toThrow(/identical SQL/u);
    });

    test("rejects multi-statement migration SQL", async () => {
        const db = await createDb();
        const runner = new MigrationRunner(db, [
            {
                version: 1,
                name: "multi",
                sql: "CREATE TABLE a (id INTEGER); CREATE TABLE b (id INTEGER);",
            },
        ]);

        await expect(runner.run()).rejects.toThrow(/more than one SQL statement/u);
    });

    test("permits semicolons inside string literals", async () => {
        const db = await createDb();
        const runner = new MigrationRunner(db, [{ version: 1, name: "literal", sql: "INSERT INTO config (k, v) VALUES ('label', 'a;b');" }]);

        const result = await runner.run();

        expect(result.applied.map((m) => m.version)).toEqual([1]);
    });

    test("permits semicolons inside comments", async () => {
        const db = await createDb();
        const runner = new MigrationRunner(db, [
            {
                version: 1,
                name: "comment",
                sql: "-- multi; line; semis\nCREATE TABLE c (id INTEGER);",
            },
        ]);

        const result = await runner.run();

        expect(result.applied.map((m) => m.version)).toEqual([1]);
    });

    test("sorts out-of-order migrations before applying", async () => {
        const db = await createDb();
        const runner = new MigrationRunner(db, [
            { version: 2, name: "two", sql: "CREATE TABLE two (id INTEGER);" },
            { version: 1, name: "one", sql: "CREATE TABLE one (id INTEGER);" },
        ]);

        const result = await runner.run();

        expect(result.applied.map((m) => m.version)).toEqual([1, 2]);
        expect(db.appliedHashes).toHaveLength(2);
    });
});
