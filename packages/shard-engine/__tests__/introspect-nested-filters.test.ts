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

    describe("boolean and number leaves under a nested path", () => {
        beforeEach(() => {
            database.raw(`CREATE TABLE "switches" ("id" TEXT PRIMARY KEY, "_creationTime" REAL NOT NULL, "__doc__" TEXT NOT NULL)`);
            database.raw(
                String.raw`INSERT INTO "switches" VALUES
                    ('s1', 1, '{"meta":{"on":true}}'),
                    ('s2', 2, '{"meta":{"on":1}}'),
                    ('s3', 3, '{"meta":{"on":false}}'),
                    ('s4', 4, '{"meta":{"on":0}}'),
                    ('s5', 5, '{"meta":{"on":"1"}}'),
                    ('s6', 6, '{"meta":{"on":1.0}}'),
                    ('s7', 7, '{"meta":{"on":null}}'),
                    ('s8', 8, '{"meta":{}}')`,
            );
        });

        const on = (operator: "eq" | "ne", value: unknown): FilterClause => {
            return { column: "meta", operator, path: ["on"], value };
        };
        const switchIds = (filter: FilterClause): string[] =>
            readTablePage(database.sql, { filters: [filter], table: "switches" }).rows.map((row) => (row as { id: string }).id);
        const selectedSwitchIds = (filter: FilterClause): string[] => selectMatchingIds(database.sql, { filters: [filter], table: "switches" }).ids;

        it("matches a nested true only to a JSON boolean, never to a stored 1", () => {
            expect.assertions(4);

            expect(switchIds(on("eq", true))).toStrictEqual(["s1"]);
            expect(selectedSwitchIds(on("eq", true))).toStrictEqual(["s1"]);
            expect(switchIds(on("eq", 1))).toStrictEqual(["s2", "s6"]);
            expect(selectedSwitchIds(on("eq", 1))).toStrictEqual(["s2", "s6"]);
        });

        it("matches a nested false only to a JSON boolean, never to a stored 0", () => {
            expect.assertions(4);

            expect(switchIds(on("eq", false))).toStrictEqual(["s3"]);
            expect(selectedSwitchIds(on("eq", false))).toStrictEqual(["s3"]);
            expect(switchIds(on("eq", 0))).toStrictEqual(["s4"]);
            expect(selectedSwitchIds(on("eq", 0))).toStrictEqual(["s4"]);
        });

        it("keeps ne the complement over the present leaves, so a stored 1 is not true and a true is not 1", () => {
            expect.assertions(4);

            // Absent and JSON null leaves stay out of both sets, as they do for every other ne.
            expect(switchIds(on("ne", true))).toStrictEqual(["s2", "s3", "s4", "s5", "s6"]);
            expect(selectedSwitchIds(on("ne", true))).toStrictEqual(["s2", "s3", "s4", "s5", "s6"]);
            expect(switchIds(on("ne", 1))).toStrictEqual(["s1", "s3", "s4", "s5"]);
            expect(selectedSwitchIds(on("ne", 1))).toStrictEqual(["s1", "s3", "s4", "s5"]);
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

    // Rows go through the real encoder so a nested bigint, Date or bytes is stored
    // exactly as the writer would store it. A separate table keeps the exact-list
    // assertions of the block above untouched.
    describe("composite values and text search under a nested path", () => {
        beforeEach(() => {
            const rows: [string, Record<string, unknown>][] = [
                ["c1", { meta: { box: { n: 1n }, count: 42, list: [new Date(3), new Uint8Array([1])], note: "bigint here" } }],
                ["c2", { meta: { box: { n: 2n }, count: 7, list: [new Date(4)], note: "plain" } }],
                ["c3", { meta: { box: { name: "bigint" }, count: 7, flag: true, list: ["a"] } }],
            ];

            database.raw(`CREATE TABLE "composite" ("id" TEXT PRIMARY KEY, "_creationTime" REAL NOT NULL, "__doc__" TEXT NOT NULL)`);

            for (const [id, document] of rows) {
                database.sql.exec(`INSERT INTO "composite" VALUES (?, ?, ?)`, id, 1, encodeDocJson(document));
            }
        });

        const compositeIds = (filters: FilterClause[]): string[] =>
            readTablePage(database.sql, { filters, table: "composite" }).rows.map((row) => (row as { id: string }).id);
        const selectedIds = (filters: FilterClause[]): string[] => selectMatchingIds(database.sql, { filters, table: "composite" }).ids;

        it("compares an object holding a bigint against its stored text, on a page and in a bulk-delete scan", () => {
            expect.assertions(4);

            const eq: FilterClause = { column: "meta", operator: "eq", path: ["box"], value: { n: 1n } };
            const ne: FilterClause = { ...eq, operator: "ne" };

            expect(compositeIds([eq])).toStrictEqual(["c1"]);
            expect(selectedIds([eq])).toStrictEqual(["c1"]);
            // `ne` must not select the row holding that very value.
            expect(compositeIds([ne])).toStrictEqual(["c2", "c3"]);
            expect(selectedIds([ne])).toStrictEqual(["c2", "c3"]);
        });

        it("compares an array holding a Date and bytes against its stored text", () => {
            expect.assertions(4);

            const eq: FilterClause = { column: "meta", operator: "eq", path: ["list"], value: [new Date(3), new Uint8Array([1])] };
            const ne: FilterClause = { ...eq, operator: "ne" };

            expect(compositeIds([eq])).toStrictEqual(["c1"]);
            expect(selectedIds([eq])).toStrictEqual(["c1"]);
            expect(compositeIds([ne])).toStrictEqual(["c2", "c3"]);
            expect(selectedIds([ne])).toStrictEqual(["c2", "c3"]);
        });

        it("still compares a plain object and array byte for byte", () => {
            expect.assertions(2);

            expect(compositeIds([{ column: "meta", operator: "eq", path: ["box"], value: { name: "bigint" } }])).toStrictEqual(["c3"]);
            expect(compositeIds([{ column: "meta", operator: "eq", path: ["list"], value: ["a"] }])).toStrictEqual(["c3"]);
        });

        it("refuses a range comparison on a composite that holds a wire-typed child", () => {
            expect.assertions(1);

            expect(rejectionOf(() => compositeIds([{ column: "meta", operator: "gt", path: ["box"], value: { n: 1n } }]))?.code).toBe("BAD_REQUEST");
        });

        it("keeps eq and ne on a scalar exact complements over the rows that hold it", () => {
            expect.assertions(2);

            // c1 holds a number at `count`; every row has one, so the two sets partition the table.
            expect(compositeIds([{ column: "meta", operator: "eq", path: ["count"], value: 7 }])).toStrictEqual(["c2", "c3"]);
            expect(compositeIds([{ column: "meta", operator: "ne", path: ["count"], value: 7 }])).toStrictEqual(["c1"]);
        });

        it("does not let contains match the codec tag of a nested bigint, Date or bytes", () => {
            expect.assertions(5);

            for (const [path, term] of [
                [["box", "n"], "bigint"],
                [["box", "n"], "lunora"],
                [["box", "n"], "wire"],
                [["list"], "date"],
                [["list"], "bytes"],
            ] as const) {
                expect(compositeIds([{ column: "meta", operator: "contains", path: [...path], value: term }])).toStrictEqual([]);
            }
        });

        it("does not select a row for a bulk delete only because its nested leaf is a codec tag", () => {
            expect.assertions(2);

            expect(selectedIds([{ column: "meta", operator: "contains", path: ["box", "n"], value: "bigint" }])).toStrictEqual([]);
            expect(selectedIds([{ column: "meta", operator: "contains", path: ["list"], value: "date" }])).toStrictEqual([]);
        });

        it("does not let contains read an object's keys or an array's text", () => {
            expect.assertions(2);

            expect(compositeIds([{ column: "meta", operator: "contains", path: ["box"], value: "name" }])).toStrictEqual([]);
            expect(compositeIds([{ column: "meta", operator: "contains", path: ["list"], value: "a" }])).toStrictEqual([]);
        });

        it("does not let a table-wide search match the codec tag of a nested value, on a page or in a bulk-delete scan", () => {
            expect.assertions(6);

            const searched = (search: string): string[] =>
                readTablePage(database.sql, { search, table: "composite" }).rows.map((row) => (row as { id: string }).id);
            const selected = (search: string): string[] => selectMatchingIds(database.sql, { search, table: "composite" }).ids;

            // c2 holds only `2n`, a Date and no text of its own: it matches `bigint` or `date` through the tag alone.
            expect(searched("bigint")).toStrictEqual(["c1", "c3"]);
            expect(selected("bigint")).toStrictEqual(["c1", "c3"]);
            expect(selected("date")).toStrictEqual([]);
            expect(selected("bytes")).toStrictEqual([]);
            expect(selected("lunora")).toStrictEqual([]);
            expect(selected("wire")).toStrictEqual([]);
        });

        it("keeps the stored payload of a nested wire-typed value searchable", () => {
            expect.assertions(1);

            // c2 holds the Date with epoch 4 and nothing else containing a 4; c1 holds 42.
            expect(selectMatchingIds(database.sql, { search: "4", table: "composite" }).ids).toStrictEqual(["c1", "c2"]);
        });

        it("keeps contains working on a nested string and a nested number", () => {
            expect.assertions(4);

            expect(compositeIds([{ column: "meta", operator: "contains", path: ["note"], value: "BIGINT" }])).toStrictEqual(["c1"]);
            expect(compositeIds([{ column: "meta", operator: "contains", path: ["box", "name"], value: "bigint" }])).toStrictEqual(["c3"]);
            expect(compositeIds([{ column: "meta", operator: "contains", path: ["count"], value: "42" }])).toStrictEqual(["c1"]);
            expect(selectedIds([{ column: "meta", operator: "contains", path: ["note"], value: "bigint" }])).toStrictEqual(["c1"]);
        });
    });

    describe("contains on a top-level document field", () => {
        beforeEach(() => {
            const rows: [string, Record<string, unknown>][] = [
                // Each of t1-t3 holds a Date, Map or Set and no text of its own, so a tag-like term can only match through the codec's frame.
                ["t1", { at: new Date(5), note: "alpha" }],
                ["t2", { pairs: new Map([["k", 1]]), note: "beta" }],
                ["t3", { group: new Set(["m"]), note: "gamma" }],
                ["t4", { at: new Date(9), note: "date night", tags: ["red", "blue"], box: { name: "bigint", n: 42 } }],
                ["t5", { tags: ["green"], box: { city: "Paris" }, flag: true, n: 7 }],
            ];

            database.raw(`CREATE TABLE "topc" ("id" TEXT PRIMARY KEY, "_creationTime" REAL NOT NULL, "__doc__" TEXT NOT NULL)`);

            for (const [id, document] of rows) {
                database.sql.exec(`INSERT INTO "topc" VALUES (?, ?, ?)`, id, 1, encodeDocJson(document));
            }
        });

        const topIds = (column: string, value: string): string[] =>
            readTablePage(database.sql, { filters: [{ column, operator: "contains", value }], table: "topc" }).rows.map((row) => (row as { id: string }).id);
        const topSelected = (column: string, value: string): string[] =>
            selectMatchingIds(database.sql, { filters: [{ column, operator: "contains", value }], table: "topc" }).ids;

        it("does not select a row through the codec tag of a Date, Map or Set field", () => {
            expect.assertions(8);

            for (const [column, term] of [
                ["at", "date"],
                ["at", "wire"],
                ["pairs", "map"],
                ["pairs", "lunora"],
                ["group", "set"],
                ["group", "wire"],
            ] as const) {
                expect(topSelected(column, term)).toStrictEqual([]);
            }

            expect(topIds("at", "date")).toStrictEqual([]);
            expect(topIds("group", "set")).toStrictEqual([]);
        });

        it("still selects a row by the real text of the same fields", () => {
            expect.assertions(3);

            // t4 stores the Date 9, t1 the Date 5: the payload stays searchable, the frame's tag and type name do not.
            expect(topSelected("at", "9")).toStrictEqual(["t4"]);
            expect(topSelected("note", "DATE")).toStrictEqual(["t4"]);
            expect(topSelected("group", "m")).toStrictEqual(["t3"]);
        });

        it("keeps contains working on a top-level string array, an object, a string and a number", () => {
            expect.assertions(6);

            expect(topIds("tags", "BLU")).toStrictEqual(["t4"]);
            expect(topSelected("tags", "green")).toStrictEqual(["t5"]);
            expect(topIds("box", "pari")).toStrictEqual(["t5"]);
            expect(topSelected("box", "bigint")).toStrictEqual(["t4"]);
            expect(topIds("note", "mm")).toStrictEqual(["t3"]);
            expect(topIds("n", "7")).toStrictEqual(["t5"]);
        });

        it("does not let contains read an array's JSON punctuation or an object's keys", () => {
            expect.assertions(3);

            expect(topIds("tags", '"')).toStrictEqual([]);
            expect(topIds("tags", ",")).toStrictEqual([]);
            expect(topIds("box", "city")).toStrictEqual([]);
        });

        it("matches the first two elements of a user array that starts with the wire tag, on a field and in a table-wide search", () => {
            expect.assertions(5);

            // The array is stored as an `arr` escape frame, so its own first two leaves sit one level below the frame's tag.
            database.sql.exec(`INSERT INTO "topc" VALUES (?, ?, ?)`, "t6", 1, encodeDocJson({ escaped: ["$lunora.wire$", "amber", "coral"] }));

            const searched = (search: string): string[] => readTablePage(database.sql, { search, table: "topc" }).rows.map((row) => (row as { id: string }).id);

            // Element 1 is the user's value; element 0 is the sentinel string the user stored, which is a value too.
            expect(topSelected("escaped", "amber")).toStrictEqual(["t6"]);
            expect(topSelected("escaped", "lunora")).toStrictEqual(["t6"]);
            expect(searched("amber")).toStrictEqual(["t6"]);
            expect(searched("lunora")).toStrictEqual(["t6"]);
            // The escape frame's own `arr` tag is still the codec's, not a value the user stored.
            expect(topSelected("escaped", "arr")).toStrictEqual([]);
        });

        it("does not match the codec tag of a bigint nested in an escaped user array, on a field and in a table-wide search", () => {
            expect.assertions(3);

            // The bigint is a codec frame inside the array's payload, so its `bigint` tag is not a value the user stored.
            database.sql.exec(`INSERT INTO "topc" VALUES (?, ?, ?)`, "t7", 1, encodeDocJson({ escaped: ["$lunora.wire$", "arr", 1n] }));

            expect(topSelected("escaped", "bigint")).toStrictEqual([]);
            // t4 holds the user string "bigint", so it is the only row a table-wide search for the word may select.
            expect(readTablePage(database.sql, { search: "bigint", table: "topc" }).rows.map((row) => (row as { id: string }).id)).toStrictEqual(["t4"]);
            // The array's own second element is the user's "arr", which is data, so the row stays selectable by it.
            expect(topSelected("escaped", "arr")).toStrictEqual(["t7"]);
        });

        it("matches a user string inside an escaped array nested in another escaped array, on a field and in a table-wide search", () => {
            expect.assertions(2);

            // "amber" sits under three arr frames, so it is the user's payload and not a codec frame.
            database.sql.exec(`INSERT INTO "topc" VALUES (?, ?, ?)`, "t9", 1, encodeDocJson({ nested: ["$lunora.wire$", "arr", ["$lunora.wire$", "amber"]] }));

            expect(topSelected("nested", "amber")).toStrictEqual(["t9"]);
            expect(readTablePage(database.sql, { search: "amber", table: "topc" }).rows.map((row) => (row as { id: string }).id)).toStrictEqual(["t9"]);
        });

        it("matches a user string nested three escaped arrays deep, so the count is exact past two levels", () => {
            expect.assertions(1);

            database.sql.exec(
                `INSERT INTO "topc" VALUES (?, ?, ?)`,
                "t10",
                1,
                encodeDocJson({ deep: ["$lunora.wire$", "arr", ["$lunora.wire$", "arr", ["$lunora.wire$", "amber"]]] }),
            );

            expect(topSelected("deep", "amber")).toStrictEqual(["t10"]);
        });

        it("does not match the codec tag of a bigint at a later element of an escaped user array", () => {
            expect.assertions(1);

            // The second bigint sits at element 3 of the payload, not at element 2, so it is a codec frame too.
            database.sql.exec(`INSERT INTO "topc" VALUES (?, ?, ?)`, "t8", 1, encodeDocJson({ escaped: ["$lunora.wire$", "arr", 1n, 2n] }));

            expect(topSelected("escaped", "bigint")).toStrictEqual([]);
        });
    });

    it("compares a nested range only against leaves of the bound's own JSON type", () => {
        expect.assertions(4);

        // SQLite ranks TEXT above every number, so a text leaf would satisfy `> 5` and a number would satisfy `< "m"`.
        database.raw(`CREATE TABLE "ranged" ("id" TEXT PRIMARY KEY, "_creationTime" REAL NOT NULL, "__doc__" TEXT NOT NULL)`);
        database.sql.exec(`INSERT INTO "ranged" VALUES (?, ?, ?)`, "r1", 1, encodeDocJson({ box: { size: 7 } }));
        database.sql.exec(`INSERT INTO "ranged" VALUES (?, ?, ?)`, "r2", 2, encodeDocJson({ box: { size: "9" } }));
        database.sql.exec(`INSERT INTO "ranged" VALUES (?, ?, ?)`, "r3", 3, encodeDocJson({ box: { size: 2 } }));

        const range = (operator: "gt" | "lt", value: unknown): FilterClause => {
            return { column: "box", operator, path: ["size"], value };
        };
        const rangedIds = (filter: FilterClause): string[] =>
            readTablePage(database.sql, { filters: [filter], table: "ranged" }).rows.map((row) => (row as { id: string }).id);

        expect(rangedIds(range("gt", 5))).toStrictEqual(["r1"]);
        expect(rangedIds(range("lt", "m"))).toStrictEqual(["r2"]);
        expect(selectMatchingIds(database.sql, { filters: [range("gt", 5)], table: "ranged" }).ids).toStrictEqual(["r1"]);
        expect(selectMatchingIds(database.sql, { filters: [range("lt", "m")], table: "ranged" }).ids).toStrictEqual(["r2"]);
    });

    it("keeps a boolean leaf out of a numeric range, and a number out of a boolean one", () => {
        expect.assertions(2);

        // json_extract reads a JSON boolean as 1 or 0, so only the leaf's JSON type keeps it out of a numeric range.
        database.raw(`CREATE TABLE "rangedb" ("id" TEXT PRIMARY KEY, "_creationTime" REAL NOT NULL, "__doc__" TEXT NOT NULL)`);
        database.sql.exec(`INSERT INTO "rangedb" VALUES (?, ?, ?)`, "b1", 1, encodeDocJson({ box: { size: 7 } }));
        database.sql.exec(`INSERT INTO "rangedb" VALUES (?, ?, ?)`, "b2", 2, encodeDocJson({ box: { size: true } }));
        database.sql.exec(`INSERT INTO "rangedb" VALUES (?, ?, ?)`, "b3", 3, encodeDocJson({ box: { size: false } }));

        const rangeIds = (value: unknown): string[] =>
            readTablePage(database.sql, { filters: [{ column: "box", operator: "gt", path: ["size"], value }], table: "rangedb" }).rows.map(
                (row) => (row as { id: string }).id,
            );

        expect(rangeIds(0)).toStrictEqual(["b1"]);
        expect(rangeIds(true)).toStrictEqual([]);
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
