import type { SchemaLike } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSqlCtxDb } from "../src/ctx-db";
import { runSqlGlobalTableMigrations } from "../src/ctx-db-migrations";
import { createSqliteHarness, makeSqliteDialect } from "./_helpers/sqlite";

/**
 * A range over a path whose leaves mix JSON types, on a `.global()` table over SQLite. The expectations are the
 * contract every backend shares: a range matches the leaves of the operand's own type and no others. The Durable
 * Object store holds the same ids in `@lunora/shard-engine`, Postgres and MySQL in `@lunora/hyperdrive`.
 */
const schema = {
    tables: {
        mixes: {
            indexes: [],
            shape: { profile: { _meta: { column: { notNull: false }, shape: {} }, kind: "object" } },
            shardMode: { kind: "global" },
        },
    },
} as never as SchemaLike;

const ROWS: [string, Record<string, unknown>][] = [
    ["n1", { mix: 5 }],
    ["n2", { mix: 50 }],
    ["n3", { mix: -1 }],
    ["s1", { mix: "7" }],
    ["s2", { mix: "abc" }],
    ["s3", { mix: "100" }],
    ["b1", { mix: true }],
    ["b2", { mix: false }],
    ["z", { mix: null }],
    ["o", { mix: { x: 1 } }],
    ["l", { mix: [1] }],
    ["m", {}],
];

const byId = (left: string, right: string): number => left.localeCompare(right);

const QUERIES: [string, Record<string, unknown>, string[]][] = [
    ["number leaves above a number", { "profile.mix": { gt: 5 } }, ["n2"]],
    ["number leaves from a number", { "profile.mix": { gte: 5 } }, ["n1", "n2"]],
    ["number leaves below a number", { "profile.mix": { lt: 5 } }, ["n3"]],
    ["number leaves up to a number", { "profile.mix": { lte: 5 } }, ["n1", "n3"]],
    ["number leaves between two numbers", { "profile.mix": { gt: 0, lt: 100 } }, ["n1", "n2"]],
    ["text leaves above a string", { "profile.mix": { gt: "7" } }, ["s2"]],
    ["text leaves below a string", { "profile.mix": { lt: "7" } }, ["s3"]],
    ["text leaves from a string", { "profile.mix": { gte: "7" } }, ["s1", "s2"]],
    ["boolean leaves above false", { "profile.mix": { gt: false } }, ["b1"]],
    ["boolean leaves up to true", { "profile.mix": { lte: true } }, ["b1", "b2"]],
    ["nothing for an operand that is no JSON scalar", { "profile.mix": { gt: 5n } }, []],
    ["every other typed leaf under NOT, and never a NULL one", { NOT: { "profile.mix": { gt: 5 } } }, ["b1", "b2", "l", "n1", "n3", "o", "s1", "s2", "s3"]],
];

describe("a range over a path whose leaves mix types", () => {
    let harness: ReturnType<typeof createSqliteHarness>;
    const dialect = makeSqliteDialect();

    const seed = async () => {
        await runSqlGlobalTableMigrations(harness.exec, schema, dialect);

        const writer = createSqlCtxDb({ clock: () => 1_700_000_000_000, dialect, exec: harness.exec, schema });

        for (const [id, profile] of ROWS) {
            // eslint-disable-next-line no-await-in-loop -- sequential inserts keep `_creationTime` in key order
            await writer.insert("mixes", { _id: id, profile }, { allowExplicitId: true });
        }

        return writer;
    };

    beforeEach(() => {
        harness = createSqliteHarness();
    });

    afterEach(() => {
        harness.close();
    });

    it.each(QUERIES)("finds %s", async (_label, where, expected) => {
        expect.assertions(2);

        const writer = await seed();
        const page = await writer.findMany("mixes", { where });

        expect(page.page.map((row) => String(row["_id"])).toSorted(byId)).toStrictEqual(expected);
        await expect(writer.count("mixes", where as never)).resolves.toBe(expected.length);
    });

    it.each(["asc", "desc"] as const)("pages through every type when ordering by the path, %s", async (sort) => {
        expect.assertions(1);

        const writer = await seed();
        const seen: string[] = [];
        let cursor: null | string | undefined;

        for (let guard = 0; guard < 10; guard += 1) {
            // eslint-disable-next-line no-await-in-loop -- each page needs the previous page's cursor
            const page = await writer.findMany("mixes", { cursor, limit: 5, orderBy: [{ "profile.mix": sort }] });

            seen.push(...page.page.map((row) => String(row["_id"])));

            if (page.isDone) {
                break;
            }

            cursor = page.continueCursor;
        }

        expect(seen.toSorted(byId)).toStrictEqual(ROWS.map(([id]) => id).toSorted(byId));
    });
});
