import { describe, expect, test } from "vitest";

import type { D1DatabaseLike, D1PreparedStatementLike } from "../src/D1Client.js";
import { MigrationRunner } from "../src/MigrationRunner.js";

interface FakeDb extends D1DatabaseLike {
    executed: { sql: string; binds: unknown[] }[];
    applied: number[];
}

const createDb = (initiallyApplied: number[] = []): FakeDb => {
    const applied = [...initiallyApplied];
    const executed: { sql: string; binds: unknown[] }[] = [];

    const makeStmt = (sql: string): D1PreparedStatementLike => {
        const binds: unknown[] = [];
        const stmt: D1PreparedStatementLike = {
            bind: (...values) => {
                binds.push(...values);

                return stmt;
            },
            first: async () => null,
            all: async () => {
                if (sql.includes("SELECT version FROM _cirrus_migrations")) {
                    return { results: applied.map((v) => ({ version: v })) as never[], success: true };
                }

                return { results: [], success: true };
            },
            run: async () => {
                executed.push({ sql, binds: [...binds] });

                if (sql.startsWith("INSERT INTO _cirrus_migrations")) {
                    applied.push(binds[0] as number);
                }

                return { success: true };
            },
            raw: async () => [],
        };

        return stmt;
    };

    const db: FakeDb = {
        executed,
        applied,
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

describe("MigrationRunner", () => {
    test("applies pending migrations in order and records them", async () => {
        const db = createDb();
        const runner = new MigrationRunner(db, [
            { version: 1, name: "init", sql: "CREATE TABLE a (id INTEGER);" },
            { version: 2, name: "add_b", sql: "CREATE TABLE b (id INTEGER);" },
        ]);

        const result = await runner.run();

        expect(result.applied.map((m) => m.version)).toEqual([1, 2]);
        expect(result.skipped).toEqual([]);
        expect(db.applied).toEqual([1, 2]);
        expect(db.executed.some((e) => e.sql.startsWith("CREATE TABLE a"))).toBe(true);
        expect(db.executed.some((e) => e.sql.startsWith("CREATE TABLE b"))).toBe(true);
    });

    test("skips already-applied migrations", async () => {
        const db = createDb([1]);
        const runner = new MigrationRunner(db, [
            { version: 1, name: "init", sql: "CREATE TABLE a (id INTEGER);" },
            { version: 2, name: "add_b", sql: "CREATE TABLE b (id INTEGER);" },
        ]);

        const result = await runner.run();

        expect(result.applied.map((m) => m.version)).toEqual([2]);
        expect(result.skipped.map((m) => m.version)).toEqual([1]);
    });

    test("rejects duplicate versions at construction time", () => {
        const db = createDb();

        expect(
            () =>
                new MigrationRunner(db, [
                    { version: 1, name: "a", sql: "" },
                    { version: 1, name: "b", sql: "" },
                ]),
        ).toThrow(/Duplicate migration version/);
    });

    test("sorts out-of-order migrations before applying", async () => {
        const db = createDb();
        const runner = new MigrationRunner(db, [
            { version: 2, name: "two", sql: "CREATE TABLE two (id INTEGER);" },
            { version: 1, name: "one", sql: "CREATE TABLE one (id INTEGER);" },
        ]);

        const result = await runner.run();

        expect(result.applied.map((m) => m.version)).toEqual([1, 2]);
        expect(db.applied).toEqual([1, 2]);
    });
});
