import { LunoraError } from "@lunora/errors";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SqlCursor, SqlExec } from "../src/ctx-db";
import type { FilterClause } from "../src/introspect";
import { readTablePage, selectMatchingIds } from "../src/introspect";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * A `SqlExec` that records every statement and its bound parameters before
 * delegating to the real engine. The assertions below read the SQL text and the
 * params separately, so a value that was interpolated into the text fails them
 * even when the query still returns the right rows.
 */
const recordingSql = (inner: SqlExec): { recorded: { params: unknown[]; sql: string }[]; sql: SqlExec } => {
    const recorded: { params: unknown[]; sql: string }[] = [];

    return {
        recorded,
        sql: {
            exec: <Row = Record<string, unknown>>(sql: string, ...params: unknown[]): SqlCursor<Row> => {
                recorded.push({ params, sql });

                return inner.exec<Row>(sql, ...params);
            },
        },
    };
};

const rejectionOf = (run: () => unknown): LunoraError | undefined => {
    try {
        run();
    } catch (error) {
        return error instanceof LunoraError ? error : undefined;
    }

    return undefined;
};

describe("readTablePage — nested paths and array membership", () => {
    let database: ReturnType<typeof createSqliteExec>;

    beforeEach(() => {
        database = createSqliteExec();

        database.raw(`CREATE TABLE "orders" ("id" TEXT PRIMARY KEY, "_creationTime" REAL NOT NULL, "__doc__" TEXT NOT NULL)`);
        database.raw(
            String.raw`INSERT INTO "orders" VALUES
                ('o1', 1, '{"address":{"city":"Berlin"},"tags":["red","blue"],"scores":[1,2,3],"flags":[true,false],"meta":{"tags":["x"]}}'),
                ('o2', 2, '{"address":{"city":"Paris"},"tags":["green"],"scores":[10],"flags":[false]}'),
                ('o3', 3, '{"address":"Berlin","tags":"blue","scores":2}'),
                ('o4', 4, '{"tags":{"blue":true},"address":{"city":"Berlin"}}'),
                ('o5', 5, '{"a.b":"flat","a":{"b":"nested"},"q''x":"hit"}')`,
        );
    });

    afterEach(() => {
        database.close();
    });

    const ids = (filters: FilterClause[]): string[] => readTablePage(database.sql, { filters, table: "orders" }).rows.map((row) => (row as { id: string }).id);

    describe("nested path", () => {
        it("reaches a field under the path, and leaves a dotted column a flat key", () => {
            expect.assertions(3);

            // o3 stores `address` as a string, so only the two objects with a city match.
            expect(ids([{ column: "address", operator: "eq", path: ["city"], value: "Berlin" }])).toEqual(["o1", "o4"]);
            // `a.b` on its own is the flat key; `a` then `b` is the nested one.
            expect(ids([{ column: "a.b", operator: "eq", value: "flat" }])).toEqual(["o5"]);
            expect(ids([{ column: "a", operator: "eq", path: ["b"], value: "nested" }])).toEqual(["o5"]);
        });

        it("binds the path segments as one parameter and keeps them out of the SQL text", () => {
            expect.assertions(3);

            const { recorded, sql } = recordingSql(database.sql);

            readTablePage(sql, { filters: [{ column: "address", operator: "eq", path: ["city"], value: "Berlin" }], table: "orders" });

            const statement = recorded.find((entry) => entry.sql.includes("COUNT"));

            expect(statement?.sql).not.toContain("city");
            expect(statement?.sql).not.toContain("$.");
            expect(statement?.params).toEqual(["$.address.city", "Berlin"]);
        });

        it("rejects an empty path segment", () => {
            expect.assertions(2);

            const error = rejectionOf(() =>
                readTablePage(database.sql, { filters: [{ column: "address", operator: "eq", path: ["", "city"], value: "x" }], table: "orders" }),
            );

            expect(error?.code).toBe("BAD_REQUEST");
            expect(error?.message).toMatch(/identifier/u);
        });

        it("rejects a path segment carrying SQL text instead of binding it", () => {
            expect.assertions(2);

            const injected = "city') OR 1=1 --";

            const error = rejectionOf(() =>
                readTablePage(database.sql, { filters: [{ column: "address", operator: "eq", path: [injected], value: "x" }], table: "orders" }),
            );

            expect(error?.code).toBe("BAD_REQUEST");
            // The table is untouched: every row is still there to be counted.
            expect(readTablePage(database.sql, { table: "orders" }).total).toBe(5);
        });

        it("binds a root field name that needs quoting, and never splices it into the SQL", () => {
            expect.assertions(3);

            const { recorded, sql } = recordingSql(database.sql);

            const page = readTablePage(sql, { filters: [{ column: "q'x", operator: "eq", value: "hit" }], table: "orders" });

            expect(page.rows.map((row) => (row as { id: string }).id)).toEqual(["o5"]);
            expect(recorded.find((entry) => entry.sql.includes("COUNT"))?.sql).not.toContain("q'x");
            expect(recorded.find((entry) => entry.sql.includes("COUNT"))?.params).toContain(`$."q'x"`);
        });

        it("refuses a nested path on a physical column", () => {
            expect.assertions(2);

            database.raw(`CREATE TABLE "messages" ("__id__" TEXT PRIMARY KEY, "text" TEXT)`);

            const error = rejectionOf(() =>
                readTablePage(database.sql, { filters: [{ column: "text", operator: "eq", path: ["x"], value: "y" }], table: "messages" }),
            );

            expect(error?.code).toBe("BAD_REQUEST");
            expect(error?.message).toMatch(/physical column/u);
        });
    });

    describe("has", () => {
        it("matches when the array contains the scalar", () => {
            expect.assertions(1);

            // o3 stores tags as the scalar "blue" and o4 as an object: neither is an array.
            expect(ids([{ column: "tags", operator: "has", value: "blue" }])).toEqual(["o1"]);
        });

        it("does not match a scalar field that equals the value", () => {
            expect.assertions(1);

            // o3's `scores` is the number 2; `has 2` is membership, so only the array o1 matches.
            expect(ids([{ column: "scores", operator: "has", value: 2 }])).toEqual(["o1"]);
        });

        it("matches a numeric element and a boolean element", () => {
            expect.assertions(2);

            expect(ids([{ column: "scores", operator: "has", value: 10 }])).toEqual(["o2"]);
            expect(ids([{ column: "flags", operator: "has", value: true }])).toEqual(["o1"]);
        });

        // `json_each` reports a JSON boolean as the integer 1 or 0, so a value-only
        // comparison would let `true` find a stored 1 and 1 find a stored true.
        it("does not match a stored 1 when asked for true", () => {
            expect.assertions(2);

            // scores is [1,2,3] on o1; the array holds no true, so nothing matches.
            expect(ids([{ column: "scores", operator: "has", value: true }])).toStrictEqual([]);
            expect(ids([{ column: "scores", operator: "has", value: 1 }])).toStrictEqual(["o1"]);
        });

        it("does not match a stored true when asked for 1, or a stored false when asked for 0", () => {
            expect.assertions(2);

            expect(ids([{ column: "flags", operator: "has", value: 1 }])).toStrictEqual([]);
            expect(ids([{ column: "flags", operator: "has", value: 0 }])).toStrictEqual([]);
        });

        it('does not match a stored 1 when asked for the string "1"', () => {
            expect.assertions(1);

            expect(ids([{ column: "scores", operator: "has", value: "1" }])).toStrictEqual([]);
        });

        it("applies the same type test in the bulk-delete selector, so it selects no row for has true", () => {
            expect.assertions(2);

            expect(selectMatchingIds(database.sql, { filters: [{ column: "scores", operator: "has", value: true }], table: "orders" }).ids).toStrictEqual([]);
            expect(selectMatchingIds(database.sql, { filters: [{ column: "scores", operator: "has", value: 1 }], table: "orders" }).ids).toStrictEqual(["o1"]);
        });

        it("matches an array nested under a path", () => {
            expect.assertions(1);

            expect(ids([{ column: "meta", operator: "has", path: ["tags"], value: "x" }])).toEqual(["o1"]);
        });

        it("compiles to json_each over the bound path with the value bound, and no literal in the SQL", () => {
            expect.assertions(4);

            const { recorded, sql } = recordingSql(database.sql);

            readTablePage(sql, { filters: [{ column: "tags", operator: "has", value: "blue" }], table: "orders" });

            const statement = recorded.find((entry) => entry.sql.includes("COUNT"));

            expect(statement?.sql).toContain(
                "EXISTS (SELECT 1 FROM json_each(\"__doc__\", ?) AS j WHERE typeof(j.key) = 'integer' AND j.type = 'text' AND j.value = ?)",
            );
            expect(statement?.sql).not.toContain("blue");
            expect(statement?.sql).not.toContain("$.tags");
            expect(statement?.params).toEqual(["$.tags", "blue"]);
        });

        it("binds the nested path into json_each rather than into a json_extract expression", () => {
            expect.assertions(2);

            const { recorded, sql } = recordingSql(database.sql);

            readTablePage(sql, { filters: [{ column: "meta", operator: "has", path: ["tags"], value: "x" }], table: "orders" });

            const statement = recorded.find((entry) => entry.sql.includes("COUNT"));

            expect(statement?.sql).toContain('json_each("__doc__", ?)');
            expect(statement?.params).toEqual(["$.meta.tags", "x"]);
        });

        it("refuses a physical column, naming the column", () => {
            expect.assertions(2);

            database.raw(`CREATE TABLE "messages" ("__id__" TEXT PRIMARY KEY, "votes" INTEGER)`);

            const error = rejectionOf(() => readTablePage(database.sql, { filters: [{ column: "votes", operator: "has", value: 1 }], table: "messages" }));

            expect(error?.code).toBe("BAD_REQUEST");
            expect(error?.message).toContain("votes");
        });

        it("refuses a value that has no element form", () => {
            expect.assertions(3);

            for (const value of [null, { a: 1 }, ["red"]]) {
                expect(rejectionOf(() => readTablePage(database.sql, { filters: [{ column: "tags", operator: "has", value }], table: "orders" }))?.code).toBe(
                    "BAD_REQUEST",
                );
            }
        });
    });

    describe("parameter budget", () => {
        // Each doc-field `eq` clause binds two parameters: its JSON path and its value.
        const eqClauses = (count: number): FilterClause[] =>
            Array.from({ length: count }, (_, index) => {
                return { column: `field${String(index)}`, operator: "eq" as const, value: index };
            });

        it("runs a page at exactly 100 bound parameters and refuses one more, naming the table", () => {
            expect.assertions(3);

            // 49 clauses bind 98; LIMIT and OFFSET make the page statement exactly 100.
            expect(readTablePage(database.sql, { filters: eqClauses(49), table: "orders" }).total).toBe(0);

            const error = rejectionOf(() => readTablePage(database.sql, { filters: eqClauses(50), table: "orders" }));

            expect(error?.code).toBe("BAD_REQUEST");
            expect(error?.message).toContain("binds 102 parameters");
        });

        it("counts the cursor and the ids statement the same way in a bulk-delete scan", () => {
            expect.assertions(2);

            // 49 clauses bind 98; the scan's LIMIT makes it 99, which is under the ceiling.
            expect(selectMatchingIds(database.sql, { filters: eqClauses(49), table: "orders" }).ids).toEqual([]);
            expect(rejectionOf(() => selectMatchingIds(database.sql, { filters: eqClauses(50), table: "orders" }))?.code).toBe("BAD_REQUEST");
        });
    });
});
