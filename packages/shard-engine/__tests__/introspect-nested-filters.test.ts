import { LunoraError } from "@lunora/errors";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SqlCursor, SqlExec } from "../src/ctx-db";
import { encodeDocJson } from "../src/do-sql";
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
            expect(error?.message).toMatch(/non-empty/u);
        });

        it("binds a path segment carrying SQL text as a literal key, never as SQL", () => {
            expect.assertions(4);

            const injected = "city') OR 1=1 --";
            const { recorded, sql } = recordingSql(database.sql);

            const page = readTablePage(sql, { filters: [{ column: "address", operator: "eq", path: [injected], value: "Berlin" }], table: "orders" });
            const statement = recorded.find((entry) => entry.sql.includes("COUNT"));

            // No object has that key, so nothing matches, and the table is untouched.
            expect(page.total).toBe(0);
            expect(readTablePage(database.sql, { table: "orders" }).total).toBe(5);
            expect(statement?.sql).not.toContain("OR 1=1");
            expect(statement?.params).toContain(`$.address."city') OR 1=1 --"`);
        });

        // A key containing a quote, a backslash, a dot or a hyphen is a real key. The
        // shared quoter escapes it, so the bound path addresses exactly that key.
        it("matches a hyphenated key and keys holding a quote, a backslash or a dot as literal keys", () => {
            expect.assertions(6);

            database.raw(`CREATE TABLE "keyed" ("id" TEXT PRIMARY KEY, "_creationTime" REAL NOT NULL, "__doc__" TEXT NOT NULL)`);
            database.raw(
                String.raw`INSERT INTO "keyed" VALUES ('k1', 1, '{"zones":{"geo-zone":"Berlin"}}'), ('k2', 2, '{"box":{"q\"x":"quote","b\\c":"slash","d.e":"dot"}}')`,
            );

            const keyed = (filters: FilterClause[]): unknown[] =>
                readTablePage(database.sql, { filters, table: "keyed" }).rows.map((row) => (row as { id: string }).id);

            expect(keyed([{ column: "zones", operator: "eq", path: ["geo-zone"], value: "Berlin" }])).toStrictEqual(["k1"]);
            expect(keyed([{ column: "box", operator: "eq", path: ['q"x'], value: "quote" }])).toStrictEqual(["k2"]);
            expect(keyed([{ column: "box", operator: "eq", path: [String.raw`b\c`], value: "slash" }])).toStrictEqual(["k2"]);
            expect(keyed([{ column: "box", operator: "eq", path: ["d.e"], value: "dot" }])).toStrictEqual(["k2"]);
            // A dot is part of the key, not a separator: `d` then `e` is a different path.
            expect(keyed([{ column: "box", operator: "eq", path: ["d", "e"], value: "dot" }])).toStrictEqual([]);

            const { recorded, sql } = recordingSql(database.sql);

            readTablePage(sql, { filters: [{ column: "box", operator: "eq", path: ['q"x'], value: "quote" }], table: "keyed" });

            expect(recorded.find((entry) => entry.sql.includes("COUNT"))?.params).toContain(String.raw`$.box."q\"x"`);
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
                "CASE WHEN json_extract(\"__doc__\", ?) IS NOT '$lunora.wire$' THEN EXISTS (SELECT 1 FROM json_each(\"__doc__\", ?) AS j WHERE typeof(j.key) = 'integer' AND j.type = 'text' AND j.value = ?) WHEN json_extract(\"__doc__\", ?) IS 'arr' THEN EXISTS (SELECT 1 FROM json_each(\"__doc__\", ?) AS j WHERE typeof(j.key) = 'integer' AND j.type = 'text' AND j.value = ?) ELSE 0 END",
            );
            expect(statement?.sql).not.toContain("blue");
            expect(statement?.sql).not.toContain("$.tags");
            expect(statement?.params).toEqual(["$.tags[0]", "$.tags", "blue", "$.tags[1]", "$.tags[2]", "blue"]);
        });

        it("binds the nested path into json_each rather than into a json_extract expression", () => {
            expect.assertions(2);

            const { recorded, sql } = recordingSql(database.sql);

            readTablePage(sql, { filters: [{ column: "meta", operator: "has", path: ["tags"], value: "x" }], table: "orders" });

            const statement = recorded.find((entry) => entry.sql.includes("COUNT"));

            expect(statement?.sql).toContain('json_each("__doc__", ?)');
            expect(statement?.params).toEqual(["$.meta.tags[0]", "$.meta.tags", "x", "$.meta.tags[1]", "$.meta.tags[2]", "x"]);
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

    // A bigint, bytes or date nested under an object is stored as a wire-tagged
    // array, written here through the real encoder rather than hand-typed JSON.
    describe("wire-typed values nested under a path", () => {
        beforeEach(() => {
            const insert = database.sql;
            const rows: [string, Record<string, unknown>][] = [
                ["w1", { meta: { n: 123n, blob: new Uint8Array([1, 2, 3]), at: new Date(5), tags: ["bigint", "x"] } }],
                ["w2", { meta: { n: 456n, blob: new Uint8Array([4, 5, 6]), tags: ["y"] } }],
                // The first element is the codec's own tag, so the array is stored as the `arr` escape frame.
                ["w3", { meta: { n: 7, tags: ["$lunora.wire$", "x"] }, topTags: ["$lunora.wire$", "z"] }],
                ["w4", { meta: { at: new Date(9), group: new Set(["a"]), pairs: new Map([["k", 1]]) } }],
            ];

            database.raw(`CREATE TABLE "wired" ("id" TEXT PRIMARY KEY, "_creationTime" REAL NOT NULL, "__doc__" TEXT NOT NULL)`);

            for (const [id, document] of rows) {
                insert.exec(`INSERT INTO "wired" VALUES (?, ?, ?)`, id, 1, encodeDocJson(document));
            }
        });

        const wiredIds = (filters: FilterClause[]): string[] =>
            readTablePage(database.sql, { filters, table: "wired" }).rows.map((row) => (row as { id: string }).id);

        it("does not let has match the tag frame of a nested bigint, bytes or date", () => {
            expect.assertions(4);

            for (const [path, value] of [
                [["n"], "bigint"],
                [["blob"], "bytes"],
                [["at"], "date"],
                [["n"], "$lunora.wire$"],
            ] as const) {
                expect(wiredIds([{ column: "meta", operator: "has", path: [...path], value }])).toStrictEqual([]);
            }
        });

        it("keeps has working on a real array that holds the same word", () => {
            expect.assertions(1);

            expect(wiredIds([{ column: "meta", operator: "has", path: ["tags"], value: "bigint" }])).toStrictEqual(["w1"]);
        });

        it("does not select a nested bigint row for a bulk delete by has", () => {
            expect.assertions(1);

            expect(
                selectMatchingIds(database.sql, { filters: [{ column: "meta", operator: "has", path: ["n"], value: "bigint" }], table: "wired" }).ids,
            ).toStrictEqual([]);
        });

        it("matches a nested bigint and nested bytes by equality against the stored frame", () => {
            expect.assertions(4);

            expect(wiredIds([{ column: "meta", operator: "eq", path: ["n"], value: 123n }])).toStrictEqual(["w1"]);
            expect(wiredIds([{ column: "meta", operator: "ne", path: ["n"], value: 123n }])).toStrictEqual(["w2", "w3"]);
            expect(wiredIds([{ column: "meta", operator: "eq", path: ["blob"], value: new Uint8Array([4, 5, 6]) }])).toStrictEqual(["w2"]);
            expect(wiredIds([{ column: "meta", operator: "eq", path: ["n"], value: 999n }])).toStrictEqual([]);
        });

        it("matches a user array that starts with the wire tag by its elements, at a nested path and at the top level", () => {
            expect.assertions(4);

            expect(wiredIds([{ column: "meta", operator: "has", path: ["tags"], value: "x" }])).toStrictEqual(["w1", "w3"]);
            expect(wiredIds([{ column: "meta", operator: "has", path: ["tags"], value: "$lunora.wire$" }])).toStrictEqual(["w3"]);
            expect(wiredIds([{ column: "topTags", operator: "has", value: "z" }])).toStrictEqual(["w3"]);
            expect(wiredIds([{ column: "meta", operator: "has", path: ["tags"], value: "arr" }])).toStrictEqual([]);
        });

        it("matches a nested date, map and set by equality against the stored frame", () => {
            expect.assertions(6);

            expect(wiredIds([{ column: "meta", operator: "eq", path: ["at"], value: new Date(9) }])).toStrictEqual(["w4"]);
            expect(wiredIds([{ column: "meta", operator: "eq", path: ["at"], value: new Date(5) }])).toStrictEqual(["w1"]);
            expect(wiredIds([{ column: "meta", operator: "eq", path: ["group"], value: new Set(["a"]) }])).toStrictEqual(["w4"]);
            expect(wiredIds([{ column: "meta", operator: "eq", path: ["pairs"], value: new Map([["k", 1]]) }])).toStrictEqual(["w4"]);
            // `ne` must not select the row holding that very value.
            expect(wiredIds([{ column: "meta", operator: "ne", path: ["at"], value: new Date(9) }])).toStrictEqual(["w1"]);
            expect(
                selectMatchingIds(database.sql, { filters: [{ column: "meta", operator: "ne", path: ["at"], value: new Date(5) }], table: "wired" }).ids,
            ).toStrictEqual(["w4"]);
        });

        it("refuses a range comparison on a nested date", () => {
            expect.assertions(1);

            expect(
                rejectionOf(() =>
                    readTablePage(database.sql, { filters: [{ column: "meta", operator: "lt", path: ["at"], value: new Date(9) }], table: "wired" }),
                )?.code,
            ).toBe("BAD_REQUEST");
        });

        it("range-compares scalar leaves only, so a stored bigint or date is never ranked above a number", () => {
            expect.assertions(4);

            // w3 holds 7; w1/w2 hold a bigint and w1/w4 a date at the compared paths.
            expect(wiredIds([{ column: "meta", operator: "gt", path: ["n"], value: 5 }])).toStrictEqual(["w3"]);
            expect(wiredIds([{ column: "meta", operator: "lte", path: ["n"], value: 100 }])).toStrictEqual(["w3"]);
            expect(wiredIds([{ column: "meta", operator: "gte", path: ["at"], value: 0 }])).toStrictEqual([]);
            expect(selectMatchingIds(database.sql, { filters: [{ column: "meta", operator: "gt", path: ["n"], value: 5 }], table: "wired" }).ids).toStrictEqual(
                ["w3"],
            );
        });

        it("refuses a range comparison on a nested bigint, whose stored text has no numeric order", () => {
            expect.assertions(2);

            const error = rejectionOf(() =>
                readTablePage(database.sql, { filters: [{ column: "meta", operator: "gt", path: ["n"], value: 1n }], table: "wired" }),
            );

            expect(error?.code).toBe("BAD_REQUEST");
            expect(error?.message).toContain("meta");
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
