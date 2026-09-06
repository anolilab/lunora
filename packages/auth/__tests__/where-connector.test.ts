import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SqlExecutor } from "../src/sql-store";
import { createSqlAuthStore } from "../src/sql-store";
import type { AuthWhereClause } from "../src/store";
import { createMemoryAuthStore, matchesWhere } from "../src/store";

/**
 * How a `connector: "OR"` clause combines with the rest of the list.
 *
 * better-auth hands an adapter a FLAT clause list in which each clause carries
 * its own connector, and every persistent adapter it ships resolves that the
 * same way: partition into an AND group and an OR group, then require both — the
 * OR clauses are an alternative among THEMSELVES, not an escape hatch from the
 * AND clauses. `@better-auth/kysely-adapter@1.7.1` pushes each group into its own
 * `.where()` (two `.where()` calls are ANDed), `@better-auth/drizzle-adapter`
 * ends in `and(andClause, orClause)`, and `@better-auth/prisma-adapter` emits
 * `{ AND: […], OR: […] }` — Prisma ANDs those too.
 *
 * Both Lunora stores used to fold the list left-associatively instead, so
 * `[A, B(OR), C(OR)]` became `A OR B OR C`: strictly BROADER than every adapter
 * above. On a credential lookup that is an authentication bypass in shape — a row
 * failing the primary condition can still be returned because a secondary one
 * matched. (`@better-auth/memory-adapter` folds left too, but it is the only one,
 * and it re-evaluates `where[0]` in the same loop; it is not the contract to
 * mirror.)
 *
 * Nothing in better-auth 1.7.1 or in this repo emits `connector: "OR"` today —
 * every occurrence is `"AND"` — so these pin the semantics before a plugin that
 * does arrives, not a live break.
 */
const clause = (field: string, value: AuthWhereClause["value"], connector: "AND" | "OR" = "AND"): AuthWhereClause => {
    return { connector, field, mode: "sensitive", operator: "eq", value };
};

/** `A AND (B OR C)` — A fails, both alternatives are live. Every adapter above says no row. */
const orGroupUnderFailingAnd = [clause("id", "u2"), clause("email", "ada@example.com", "OR"), clause("age", 99, "OR")];

/** `A AND (B OR C)` — A holds and one alternative holds. Every adapter says the row matches. */
const orGroupUnderPassingAnd = [clause("id", "u1"), clause("email", "nobody@example.com", "OR"), clause("age", 30, "OR")];

const row = { age: 30, email: "ada@example.com", id: "u1" };

let database: DatabaseSync;

const executorFor = (databaseSync: DatabaseSync): SqlExecutor => {
    return {
        all: (sql, parameters) => Promise.resolve(databaseSync.prepare(sql).all(...(parameters as never[])) as Record<string, unknown>[]),
        run: (sql, parameters) => {
            databaseSync.prepare(sql).run(...(parameters as never[]));

            return Promise.resolve();
        },
    };
};

describe("where-clause connectors", () => {
    beforeEach(() => {
        database = new DatabaseSync(":memory:");
        database.exec(`CREATE TABLE "users" ("id" TEXT PRIMARY KEY, "email" TEXT, "age" REAL)`);
    });

    afterEach(() => {
        database.close();
    });

    describe("matchesWhere", () => {
        it("does not let an OR clause rescue a row that fails an AND clause", () => {
            expect.assertions(1);

            expect(matchesWhere(row, orGroupUnderFailingAnd)).toBe(false);
        });

        it("matches when the AND clause holds and one OR alternative holds", () => {
            expect.assertions(1);

            expect(matchesWhere(row, orGroupUnderPassingAnd)).toBe(true);
        });

        it("requires at least one alternative when the list is all OR", () => {
            expect.assertions(2);

            expect(matchesWhere(row, [clause("id", "u2", "OR"), clause("age", 30, "OR")])).toBe(true);
            expect(matchesWhere(row, [clause("id", "u2", "OR"), clause("age", 99, "OR")])).toBe(false);
        });
    });

    describe("createSqlAuthStore", () => {
        it("compiles the same grouping as the in-memory store", async () => {
            expect.assertions(3);

            const store = createSqlAuthStore(executorFor(database));

            await store.create("users", row);

            await expect(store.read("users", { where: orGroupUnderFailingAnd })).resolves.toEqual([]);
            await expect(store.read("users", { where: orGroupUnderPassingAnd })).resolves.toHaveLength(1);
            await expect(store.read("users", { where: [clause("id", "u2", "OR"), clause("age", 99, "OR")] })).resolves.toEqual([]);
        });

        it("agrees with the memory store on the same clause list", async () => {
            expect.assertions(2);

            const memory = createMemoryAuthStore();
            const sql = createSqlAuthStore(executorFor(database));

            await memory.create("users", row);
            await sql.create("users", row);

            const pairs = await Promise.all(
                [orGroupUnderFailingAnd, orGroupUnderPassingAnd].map(async (where) => {
                    const fromSql = await sql.read("users", { where });
                    const fromMemory = await memory.read("users", { where });

                    return { memoryCount: fromMemory.length, sqlCount: fromSql.length };
                }),
            );

            for (const { memoryCount, sqlCount } of pairs) {
                expect(sqlCount).toBe(memoryCount);
            }
        });
    });
});
