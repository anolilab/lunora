import type { ColumnMetaLike, DatabaseWriterLike, SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { runSqlGlobalTableMigrations } from "@lunora/sql-store";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { MIX_QUERIES, MIX_ROWS, pageAllMixed } from "../../shard-engine/__tests__/_helpers/mixed-type-paths";
import { createHyperdriveGlobalCtxDb } from "../src/global";
import { mysqlDialect, postgresDialect } from "../src/global-dialect";
import type { MysqlHarness } from "./_helpers/mysql-mem";
import { tryCreateMysqlHarness } from "./_helpers/mysql-mem";
import type { PgliteHarness } from "./_helpers/pglite-exec";
import createPgliteHarness from "./_helpers/pglite-exec";

/**
 * Dotted paths into an object column (`where: { "profile.plan": "pro" }`, `orderBy: [{ "profile.age": "asc" }]`)
 * on a `.global()` table over a real Postgres (PGlite, Postgres 18) and a real MySQL 8.
 *
 * The expectations follow the SQLite/Durable Object reading of a path, which is the one every backend must
 * agree with: a missing key, a step through an array or scalar, a JSON `null` leaf, a wire-encoded object (a
 * bigint inside it) and a column holding text that is not JSON all read as NULL, never as an error. A value keeps
 * its JSON type, so `30` does not equal `"30"`. A range over a path is bracketed to the operand's type
 * (`gt: 5` never matches a string or boolean leaf), which is what the SQLite store answers too.
 *
 * MySQL is provisioned by `mysql-memory-server`; where that download is blocked the MySQL half skips with the
 * captured reason, exactly as `global-null-placement.test.ts` does.
 */
const STARTUP_TIMEOUT = 180_000;
const TEST_TIMEOUT = 30_000;

const col = (kind: string, column: Partial<ColumnMetaLike> = {}): ValidatorLike => {
    return { _meta: { column: { notNull: false, ...column } }, kind };
};

/** An object column with no declared leaves: the path reads whatever the stored JSON holds. */
const objectColumn: ValidatorLike = { _meta: { column: { notNull: false }, shape: {} }, kind: "object" };

const schema = {
    tables: {
        docs: {
            indexes: [],
            shape: { label: col("string"), profile: objectColumn },
            shardMode: { kind: "global" },
        },
        scores: {
            indexes: [],
            shape: { profile: objectColumn },
            shardMode: { kind: "global" },
        },
        mixes: {
            indexes: [],
            shape: { profile: objectColumn },
            shardMode: { kind: "global" },
        },
    },
} as never as SchemaLike;

/**
 * The `docs` rows, each named for what it exercises. `i` holds a bigint, which is stored wire-encoded, so the
 * whole `profile` reads as non-JSON; `j` holds a string column with text that is not JSON.
 */
const DOCS: [string, Record<string, unknown>][] = [
    ["a", { label: "ada", profile: { active: true, age: 30, code: 30, name: "ada", plan: "pro" } }],
    ["b", { profile: { active: false, age: 20, code: "30", name: "bob", plan: "free" } }],
    ["c", { profile: { active: true, age: 45, name: "cy", plan: "pro" } }],
    ["d", { profile: { plan: "pro" } }],
    ["e", { profile: [30, { age: 30 }] }],
    ["f", { profile: "text" }],
    ["g", {}],
    ["h", { profile: { age: null, plan: "free" } }],
    ["i", { profile: { big: 10n, plan: "pro" } }],
    ["j", { label: "{not json" }],
    ["k", { profile: { a: { b: { c: 7 } } } }],
    ["m", { profile: { plan: "pro", 'we"ird\\key': 1 } }],
    // The same text in a path and in a string column, so `contains` can be checked against the column's own search.
    ["p", { label: String.raw`Ada 100%_x\y`, profile: { name: String.raw`Ada 100%_x\y` } }],
];

/** Four NULLs (missing key, JSON null, a non-object step, no object), a tie on 3, so a page boundary lands inside the NULL run. */
const SCORES: [string, Record<string, unknown>][] = [
    ["a", { profile: { age: 3 } }],
    ["b", { profile: { age: null } }],
    ["c", {}],
    ["d", { profile: { age: 1 } }],
    ["e", { profile: { age: null } }],
    ["f", { profile: { age: 3 } }],
    ["g", { profile: { age: 2 } }],
    ["h", { profile: "x" }],
];

interface Combo {
    nulls: "first" | "last";
    sort: "asc" | "desc";
}

const COMBOS: Combo[] = [
    { nulls: "first", sort: "asc" },
    { nulls: "last", sort: "asc" },
    { nulls: "first", sort: "desc" },
    { nulls: "last", sort: "desc" },
];

/** The order a correct engine returns: by age with the NULL group where asked, ties by id in the sort's direction. */
const expectedOrder = ({ nulls, sort }: Combo): string[] => {
    const age = (id: string): number | null => {
        const row = SCORES.find(([rowId]) => rowId === id)?.[1];
        const profile = row?.["profile"];
        const value = typeof profile === "object" && profile !== null && !Array.isArray(profile) ? (profile as Record<string, unknown>)["age"] : undefined;

        return typeof value === "number" ? value : null;
    };
    const sign = sort === "asc" ? 1 : -1;

    return SCORES.map(([id]) => id).toSorted((leftId, rightId) => {
        const left = age(leftId);
        const right = age(rightId);

        if (left !== right) {
            if (left === null) {
                return nulls === "first" ? -1 : 1;
            }

            if (right === null) {
                return nulls === "first" ? 1 : -1;
            }

            return (left - right) * sign;
        }

        return leftId.localeCompare(rightId) * sign;
    });
};

let mysql: MysqlHarness;
let mysqlUnavailable: string | undefined;
let pg: PgliteHarness;

const seed = async (engine: "mysql" | "postgres"): Promise<DatabaseWriterLike> => {
    const exec = engine === "mysql" ? mysql.exec : pg.exec;

    await runSqlGlobalTableMigrations(exec, schema, engine === "mysql" ? mysqlDialect : postgresDialect);

    const writer = createHyperdriveGlobalCtxDb({ clock: () => 1_700_000_000_000, engine, exec, schema });

    for (const [id, document] of DOCS) {
        // eslint-disable-next-line no-await-in-loop -- deterministic seed order on a single shared connection
        await writer.insert("docs", { _id: id, ...document }, { allowExplicitId: true });
    }

    for (const [id, document] of SCORES) {
        // eslint-disable-next-line no-await-in-loop -- deterministic seed order on a single shared connection
        await writer.insert("scores", { _id: id, ...document }, { allowExplicitId: true });
    }

    for (const [id, profile] of MIX_ROWS) {
        // eslint-disable-next-line no-await-in-loop -- deterministic seed order on a single shared connection
        await writer.insert("mixes", { _id: id, profile }, { allowExplicitId: true });
    }

    return writer;
};

const byId = (left: string, right: string): number => left.localeCompare(right);

/** The ids of every `docs` row a filter matches, sorted, so an assertion does not depend on the engine's row order. */
const matching = async (writer: DatabaseWriterLike, where: Record<string, unknown>): Promise<string[]> => {
    const page = await writer.findMany("docs", { where });

    return page.page.map((row) => String(row["_id"])).toSorted(byId);
};

/** Page through `scores` three rows at a time and return every id in the order the pages came back. */
const pageAll = async (writer: DatabaseWriterLike, combo: Combo): Promise<string[]> => {
    const seen: string[] = [];
    let cursor: null | string | undefined;

    for (let guard = 0; guard < 10; guard += 1) {
        // eslint-disable-next-line no-await-in-loop -- each page needs the previous page's cursor
        const page = await writer.findMany("scores", { cursor, limit: 3, orderBy: [{ "profile.age": combo }] });

        seen.push(...page.page.map((row) => String(row["_id"])));

        if (page.isDone) {
            return seen;
        }

        cursor = page.continueCursor;
    }

    throw new Error("paging did not terminate");
};

describe.each([["postgres"], ["mysql"]] as const)("global store — dotted JSON paths on %s", (engine) => {
    beforeAll(async () => {
        if (engine === "mysql") {
            const result = await tryCreateMysqlHarness();

            if (result.harness) {
                mysql = result.harness;
            } else {
                mysqlUnavailable = result.unavailable;
            }
        }
    }, STARTUP_TIMEOUT);

    beforeEach(async (context) => {
        if (engine === "mysql") {
            if (mysqlUnavailable !== undefined) {
                context.skip(mysqlUnavailable);
            }

            await mysql.query("DROP TABLE IF EXISTS `docs`");
            await mysql.query("DROP TABLE IF EXISTS `scores`");
            await mysql.query("DROP TABLE IF EXISTS `mixes`");
        } else {
            pg = await createPgliteHarness();
        }
    });

    afterEach(async () => {
        if (engine === "postgres") {
            await pg?.close();
        }
    });

    afterAll(async () => {
        if (engine === "mysql") {
            await mysql?.close();
        }
    });

    it.each([
        ["a number leaf", { "profile.code": 30 }, ["a"]],
        ["a string leaf holding the same digits, which is not the number", { "profile.code": "30" }, ["b"]],
        ["a number leaf, on a different key", { "profile.age": 30 }, ["a"]],
        ["a boolean leaf, true", { "profile.active": true }, ["a", "c"]],
        ["a boolean leaf, false", { "profile.active": false }, ["b"]],
        ["a text leaf", { "profile.name": "ada" }, ["a"]],
        ["a text leaf that several rows share", { "profile.plan": "pro" }, ["a", "c", "d", "m"]],
        ["a nested leaf three steps down", { "profile.a.b.c": 7 }, ["k"]],
        ["an in-list of numbers", { "profile.age": { in: [30, 45] } }, ["a", "c"]],
        ["a not-in list, which leaves out a NULL leaf", { "profile.age": { notIn: [30] } }, ["b", "c"]],
        ["an in-list holding NULL, which matches only the value", { "profile.age": { in: [30, null] } }, ["a"]],
        ["a not-in list holding NULL, which matches nothing", { "profile.age": { notIn: [30, null] } }, []],
        ["a number range, gt", { "profile.age": { gt: 30 } }, ["c"]],
        ["a number range, gte", { "profile.age": { gte: 30 } }, ["a", "c"]],
        ["a key with a quote and a backslash in it", { 'profile.we"ird\\key': 1 }, ["m"]],
    ])(
        "matches %s",
        async (_label, where, expected) => {
            expect.assertions(1);

            await expect(matching(await seed(engine), where)).resolves.toStrictEqual(expected.toSorted(byId));
        },
        TEST_TIMEOUT,
    );

    it.each([
        ["a missing key", { "profile.age": null }, ["d", "e", "f", "g", "h", "i", "j", "k", "m", "p"]],
        ["a missing or null leaf", { "profile.plan": null }, ["e", "f", "g", "i", "j", "k", "p"]],
        ["an array step, where a key would be", { "profile.0": 30 }, []],
    ])(
        "treats %s as NULL, excluded from a value filter",
        async (_label, where, expected) => {
            expect.assertions(1);

            await expect(matching(await seed(engine), where)).resolves.toStrictEqual(expected.toSorted(byId));
        },
        TEST_TIMEOUT,
    );

    it(
        "reads NULL, not an error, where the column holds text that is not JSON",
        async () => {
            expect.assertions(2);

            const writer = await seed(engine);

            // `j` holds "{not json" in a string column. A cast would raise on it and fail the whole read.
            await expect(matching(writer, { "label.x": "y" })).resolves.toStrictEqual([]);
            await expect(matching(writer, { "label.x": null })).resolves.toContain("j");
        },
        TEST_TIMEOUT,
    );

    it(
        "refuses a path longer than four segments before it reaches SQL",
        async () => {
            expect.assertions(1);

            const writer = await seed(engine);

            await expect(writer.findMany("docs", { where: { "profile.a.b.c.d": 1 } })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        },
        TEST_TIMEOUT,
    );

    it(
        "does not let a hostile key name break out of the path",
        async () => {
            expect.assertions(2);

            const writer = await seed(engine);

            await expect(matching(writer, { "profile.plan') OR 1=1 --": "x" })).resolves.toStrictEqual([]);

            const everything = await writer.findMany("docs", {});

            expect(everything.page).toHaveLength(DOCS.length);
        },
        TEST_TIMEOUT,
    );

    it(
        "matches a long in-list over a path, past the bind parameters a literal list can carry",
        async () => {
            expect.assertions(1);

            // 40,000 items: past the 32,767 parameters a literal list can bind on the wire, where a literal path list
            // matched nothing on PGlite without raising. The list goes as one JSON array parameter instead.
            const candidates = Array.from({ length: 40_000 }, (_unused, index) => index + 100);

            await expect(matching(await seed(engine), { "profile.age": { in: [...candidates, 30] } })).resolves.toStrictEqual(["a"]);
        },
        TEST_TIMEOUT,
    );

    it.each([
        // The path's text against each term: the same answer the column's own `contains` gives on the same text (below).
        ["Ada", ["p"]],
        ["ada", ["a"]],
        ["ADA", []],
        ["100%", ["p"]],
        ["%", ["p"]],
        ["_x", ["p"]],
        ["10%x", []],
        [String.raw`x\y`, ["p"]],
    ])(
        "matches contains %j on a path exactly as on a string column",
        async (needle, expected) => {
            expect.assertions(2);

            const writer = await seed(engine);

            await expect(matching(writer, { "profile.name": { contains: needle } })).resolves.toStrictEqual(expected);
            await expect(matching(writer, { label: { contains: needle } })).resolves.toStrictEqual(expected);
        },
        TEST_TIMEOUT,
    );

    it(
        "searches a path's leaf text for a string leaf, and is not a JSON-text search",
        async () => {
            expect.assertions(2);

            const writer = await seed(engine);

            // `"` is JSON's quote. The stored text is `"ada"`, but the leaf's own text is `ada`, so `"a` finds nothing.
            // `da` is in both `ada` and `Ada 100%_x\y`.
            await expect(matching(writer, { "profile.name": { contains: "da" } })).resolves.toStrictEqual(["a", "p"]);
            await expect(matching(writer, { "profile.name": { contains: '"a' } })).resolves.toStrictEqual([]);
        },
        TEST_TIMEOUT,
    );

    it.each(COMBOS)(
        "orders by a path with nulls $nulls, $sort",
        async (combo) => {
            expect.assertions(1);

            await expect(pageAll(await seed(engine), combo)).resolves.toStrictEqual(expectedOrder(combo));
        },
        TEST_TIMEOUT,
    );

    it.each(MIX_QUERIES)(
        "brackets a range over a mixed-type path to the operand's type: %s",
        async (_label, where, expected) => {
            expect.assertions(1);

            const writer = await seed(engine);
            const page = await writer.findMany("mixes", { where });

            expect(page.page.map((row) => String(row["_id"])).toSorted(byId)).toStrictEqual(expected);
        },
        TEST_TIMEOUT,
    );

    it.each(["asc", "desc"] as const)(
        "pages through every type when ordering by a mixed-type path, %s",
        async (sort) => {
            expect.assertions(1);

            const writer = await seed(engine);
            const seen = await pageAllMixed((args) => writer.findMany("mixes", args), sort);

            expect(seen.toSorted(byId)).toStrictEqual(MIX_ROWS.map(([id]) => id).toSorted(byId));
        },
        TEST_TIMEOUT,
    );
});
