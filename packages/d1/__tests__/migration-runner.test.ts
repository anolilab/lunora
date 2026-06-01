import { describe, expect, it } from "vitest";

import type { D1DatabaseLike, D1PreparedStatementLike } from "../src/d1-client.js";
import { MigrationRunner } from "../src/migration-runner.js";

interface FakeDatabase extends D1DatabaseLike {
    appliedHashes: string[];
    executed: { binds: unknown[]; sql: string }[];
}

// Matchers hoisted to module scope (avoids per-call regex recompilation).
const TRACKING_INSERT_HASH_RE = /VALUES \('([0-9a-f]{64})'/u;
const DUPLICATE_VERSION_RE = /Duplicate migration version/;
const IDENTICAL_SQL_RE = /identical SQL/u;
const MULTI_STATEMENT_RE = /more than one SQL statement/u;

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
});
