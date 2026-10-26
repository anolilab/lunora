import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { matchesStaticWhere } from "../src/aggregate-sql";
import type { SchemaLike, ValidatorLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, readCdcCursor, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Dotted paths into an object column, on a real SQLite engine: `where: { "profile.plan": "pro" }` and
 * `patch(id, { "profile.plan": "team" })`.
 *
 * The expected ids below are written out by hand rather than computed, so a SQL path and a JS reader that
 * were wrong in the same way would still fail. Each row exists to pin one boundary: a missing intermediate
 * object, a null leaf, and a number stored as text (`30` must not equal `"30"`).
 */
const scalar = (kind: string, accepts: (value: unknown) => boolean): ValidatorLike => {
    return {
        _meta: { column: { notNull: true } },
        kind,
        parse: (value: unknown) => {
            if (!accepts(value)) {
                throw new Error(`must be a ${kind}`);
            }

            return value;
        },
    };
};

const objectOf = (shape: Record<string, ValidatorLike>): ValidatorLike => {
    return { _meta: { column: { notNull: true }, shape }, kind: "object" };
};

const schema: SchemaLike = {
    tables: {
        users: {
            dropStalePatchesMode: true,
            indexes: [],
            // Ranks only the pro users, by a static `where` that is itself a path into `profile`.
            rankIndexes: [{ name: "pros", on: "users", sortBy: [{ direction: "asc", field: "name" }], where: { "profile.plan": "pro" } }],
            shape: {
                name: scalar("string", (value) => typeof value === "string"),
                profile: {
                    _meta: {
                        column: { notNull: false },
                        shape: {
                            address: objectOf({ city: scalar("string", (value) => typeof value === "string" || value === null) }),
                            age: scalar("number", (value) => typeof value === "number"),
                            flags: objectOf({ beta: scalar("boolean", (value) => typeof value === "boolean") }),
                            plan: scalar("string", (value) => typeof value === "string" || value === null),
                        },
                    },
                    kind: "object",
                },
                // `v.union(v.object({ theme }), v.null())`: the usual way to write a nullable object.
                settings: {
                    _meta: { members: [objectOf({ theme: scalar("string", (value) => typeof value === "string") }), { kind: "null" }] },
                    kind: "union",
                },
            },
        },
    },
};

/** id → document. `e` has no profile at all. */
const ROWS: Record<string, Record<string, unknown>> = {
    a: { name: "a", profile: { address: { city: "Berlin" }, age: 30, flags: { beta: true }, plan: "pro" } },
    b: { name: "b", profile: { plan: "free" } },
    c: { name: "c", profile: { age: "30", plan: "pro" } },
    d: { name: "d", profile: { address: { city: null }, plan: null } },
    e: { name: "e" },
};

let harness: ReturnType<typeof createSqliteExec>;

const seed = async () => {
    runShardMigrations(harness.sql, schema, { cdc: true });

    let now = 1_700_000_000_000;
    let baseline: number | undefined;
    const writer = createShardContextDatabase({
        baselineSeq: () => baseline,
        broadcast: () => undefined,
        cdc: true,
        clock: () => {
            now += 1000;

            return now;
        },
        schema,
        sql: harness.sql,
    });

    for (const [id, document] of Object.entries(ROWS)) {
        // eslint-disable-next-line no-await-in-loop -- sequential inserts keep `_creationTime` in key order
        await writer.insert("users", { ...document, _id: id }, { allowExplicitId: true });
    }

    return {
        setBaseline: (seq: number | undefined): void => {
            baseline = seq;
        },
        writer,
    };
};

const idsOf = (page: { page: Record<string, unknown>[] }): string[] =>
    page.page.map((row) => String(row["_id"])).toSorted((left, right) => left.localeCompare(right));

const QUERIES: [string, Record<string, unknown>, string[]][] = [
    ["a string leaf", { "profile.plan": "pro" }, ["a", "c"]],
    ["a leaf two levels down", { "profile.address.city": "Berlin" }, ["a"]],
    ["a boolean leaf", { "profile.flags.beta": true }, ["a"]],
    ["a number leaf equal to a number, not to the same digits as text", { "profile.age": 30 }, ["a"]],
    ["a null or missing leaf", { "profile.plan": null }, ["d", "e"]],
    ["a missing intermediate object reads as null", { "profile.address.city": null }, ["b", "c", "d", "e"]],
    ["isNull on a path", { "profile.address.city": { isNull: true } }, ["b", "c", "d", "e"]],
    ["an in-list on a path", { "profile.plan": { in: ["free", "pro"] } }, ["a", "b", "c"]],
    ["a path under OR", { OR: [{ "profile.plan": "free" }, { "profile.flags.beta": true }] }, ["a", "b"]],
    ["a path beside a column", { name: "c", "profile.plan": "pro" }, ["c"]],
    ["a path that exists on no row", { "profile.nope": "x" }, []],
];

describe("dotted paths into an object column", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    describe("where", () => {
        it.each(QUERIES)("finds %s", async (_label, where, expected) => {
            expect.assertions(2);

            const { writer } = await seed();

            expect(idsOf(await writer.findMany("users", { where }))).toStrictEqual(expected);
            await expect(writer.count("users", where as never)).resolves.toBe(expected.length);
        });

        it("orders by a path", async () => {
            expect.assertions(1);

            const { writer } = await seed();
            const page = await writer.findMany("users", { orderBy: [{ "profile.plan": "asc" }], where: { "profile.plan": { in: ["free", "pro"] } } } as never);

            expect(page.page.map((row) => row["_id"])).toStrictEqual(["b", "a", "c"]);
        });

        it("rejects a path that is too deep before building any SQL", async () => {
            expect.assertions(1);

            const { writer } = await seed();

            await expect(writer.findMany("users", { where: { "profile.a.b.c.d": "x" } })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        });

        it("does not let a hostile segment break out of the path", async () => {
            expect.assertions(2);

            const { writer } = await seed();
            const hostile = await writer.findMany("users", { where: { "profile.plan') OR 1=1 --": "x" } });

            expect(hostile.page).toStrictEqual([]);
            expect(idsOf(await writer.findMany("users"))).toStrictEqual(["a", "b", "c", "d", "e"]);
        });
    });

    describe("the JS reader agrees with the SQL", () => {
        it.each([
            ["a leaf", { "profile.plan": "pro" }, "a", true],
            ["a leaf that differs", { "profile.plan": "pro" }, "b", false],
            ["a missing intermediate as null", { "profile.address.city": null }, "b", true],
            ["no profile as null", { "profile.plan": null }, "e", true],
            ["a number is not its digits as text", { "profile.age": 30 }, "c", false],
            ["a leaf under { eq }", { "profile.plan": { eq: "free" } }, "b", true],
        ])("%s", (_label, predicate, id, expected) => {
            expect.assertions(1);

            expect(matchesStaticWhere(ROWS[id] as Record<string, unknown>, predicate as Record<string, unknown>)).toBe(expected);
        });
    });

    describe("patch", () => {
        it("sets one nested key and keeps its siblings", async () => {
            expect.assertions(2);

            const { writer } = await seed();

            await writer.patch("a", { "profile.plan": "team" });

            const row = await writer.get("users", "a");

            expect(row?.["profile"]).toStrictEqual({ address: { city: "Berlin" }, age: 30, flags: { beta: true }, plan: "team" });

            const row_b = await writer.get("users", "b");

            expect(row_b?.["profile"]).toStrictEqual({ plan: "free" });
        });

        it("creates the objects on the way down when they are missing", async () => {
            expect.assertions(1);

            const { writer } = await seed();

            await writer.patch("e", { "profile.address.city": "Paris" });

            const row_e = await writer.get("users", "e");

            expect(row_e?.["profile"]).toStrictEqual({ address: { city: "Paris" } });
        });

        it("folds several paths into the same column in one patch", async () => {
            expect.assertions(1);

            const { writer } = await seed();

            await writer.patch("b", { "profile.age": 41, "profile.flags.beta": false });

            const row_b = await writer.get("users", "b");

            expect(row_b?.["profile"]).toStrictEqual({ age: 41, flags: { beta: false }, plan: "free" });
        });

        it("compares a numeric leaf by order once the column holds numbers", async () => {
            expect.assertions(1);

            const { writer } = await seed();

            await writer.patch("c", { "profile.age": 25 });

            expect(idsOf(await writer.findMany("users", { where: { "profile.age": { gt: 20 } } }))).toStrictEqual(["a", "c"]);
        });

        it("works through patchIf and patchMany", async () => {
            expect.assertions(3);

            const { writer } = await seed();

            const applied = await writer.patchIf?.("users", "a", { patch: { "profile.plan": "via-if" }, where: { name: "a" } });

            await writer.patchMany?.([{ id: "b", patch: { "profile.plan": "via-many" } }]);

            const first = await writer.get("users", "a");
            const second = await writer.get("users", "b");

            expect(applied?.applied).toBe(true);
            expect(first?.["profile"]).toMatchObject({ age: 30, plan: "via-if" });
            expect(second?.["profile"]).toStrictEqual({ plan: "via-many" });
        });

        it("sets a key inside a nullable object column, creating the object when the column is null", async () => {
            expect.assertions(1);

            const { writer } = await seed();

            await writer.patch("a", { "settings.theme": "dark" });

            const row = await writer.get("users", "a");

            expect(row?.["settings"]).toStrictEqual({ theme: "dark" });
        });

        it("refuses two paths where one is inside the other, whose result would depend on key order", async () => {
            expect.assertions(2);

            const { writer } = await seed();
            const overlap = { "profile.address": { city: "x" }, "profile.address.city": "y" };

            await expect(writer.patch("a", overlap as never)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
            await expect(writer.patch("a", Object.fromEntries(Object.entries(overlap).toReversed()) as never)).rejects.toMatchObject({
                code: "VALIDATION_ERROR",
            });
        });

        it("is found by a path filter afterwards", async () => {
            expect.assertions(1);

            const { writer } = await seed();

            await writer.patch("b", { "profile.plan": "pro" });

            expect(idsOf(await writer.findMany("users", { where: { "profile.plan": "pro" } }))).toStrictEqual(["a", "b", "c"]);
        });

        it.each([
            ["a path the schema does not declare", { "profile.nope": 1 }],
            ["a path through a column that is not an object", { "name.first": "x" }],
            ["a value of the wrong type", { "profile.age": "old" }],
            ["a nested operator", { "profile.age": { increment: 1 } }],
            ["a column and a path into it together", { profile: {}, "profile.plan": "x" }],
            ["a path with an empty segment", { "profile..plan": "x" }],
            ["a path that is too deep", { "profile.a.b.c.d": "x" }],
        ])("rejects %s and leaves the row alone", async (_label, patch) => {
            expect.assertions(2);

            const { writer } = await seed();

            await expect(writer.patch("a", patch as never)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

            const row_a = await writer.get("users", "a");

            expect(row_a?.["profile"]).toStrictEqual(ROWS["a"]?.["profile"]);
        });

        it("judges staleness by the leaf, so a sibling edit in the same object is not a conflict", async () => {
            expect.assertions(2);

            const { setBaseline, writer } = await seed();
            const baseline = readCdcCursor(harness.sql);

            // Someone else edits a different key of the same object, then the caller's late write lands.
            await writer.patch("a", { "profile.age": 31 });
            setBaseline(baseline);
            await writer.patch("a", { "profile.plan": "team" });
            setBaseline(undefined);

            const afterSibling = await writer.get("users", "a");

            expect(afterSibling?.["profile"]).toMatchObject({ age: 31, plan: "team" });

            // The same leaf edited underneath it is stale: the late write is dropped.
            const second = readCdcCursor(harness.sql);

            await writer.patch("a", { "profile.plan": "theirs" });
            setBaseline(second);
            await writer.patch("a", { "profile.plan": "mine" });

            const afterSameLeaf = await writer.get("users", "a");

            expect(afterSameLeaf?.["profile"]).toMatchObject({ plan: "theirs" });
        });
    });

    describe("a rank index whose static where is a path", () => {
        it("follows a row into and out of the index when its path value changes", async () => {
            expect.assertions(5);

            const { writer } = await seed();

            // a and c are "pro" in the fixture.
            await expect(writer.rank("users", "pros", { row: "a" })).resolves.toStrictEqual({ position: 1, total: 2 });

            await writer.patch("b", { "profile.plan": "pro" });

            await expect(writer.rank("users", "pros", { row: "b" })).resolves.toStrictEqual({ position: 2, total: 3 });

            await writer.patch("a", { "profile.plan": "free" });

            await expect(writer.rank("users", "pros", { row: "a" })).resolves.toBeNull();
            await expect(writer.rank("users", "pros", { row: "b" })).resolves.toStrictEqual({ position: 1, total: 2 });
            await expect(writer.rank("users", "pros", { row: "c" })).resolves.toStrictEqual({ position: 2, total: 2 });
        });
    });

    describe("ordering and paging by a path", () => {
        it("pages by a path with no gap and no repeat, nulls first", async () => {
            expect.assertions(2);

            const { writer } = await seed();
            const unpaged = await writer.findMany("users", { orderBy: [{ "profile.plan": "asc" }] } as never);
            const labels: string[] = [];
            let cursor: null | string | undefined;

            for (let guard = 0; guard < 10; guard += 1) {
                // eslint-disable-next-line no-await-in-loop -- each page needs the previous page's cursor
                const page = await writer.findMany("users", { cursor, limit: 2, orderBy: [{ "profile.plan": "asc" }] } as never);

                labels.push(...page.page.map((row) => String(row["_id"])));

                if (page.isDone) {
                    break;
                }

                cursor = page.continueCursor;
            }

            // NULL plans (d, e) first in creation order, then free (b), then pro (a, c).
            expect(unpaged.page.map((row) => row["_id"])).toStrictEqual(["d", "e", "b", "a", "c"]);
            expect(labels).toStrictEqual(["d", "e", "b", "a", "c"]);
        });
    });
});
