import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import { byId, MIX_QUERIES, MIX_ROWS, pageAllMixed } from "./_helpers/mixed-type-paths";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * A range (`gt`/`gte`/`lt`/`lte`) over a path whose leaves mix JSON types, on a real SQLite engine.
 *
 * Each engine orders values of different types its own way, so an unbracketed `gt: 5` matched the text leaves on
 * SQLite and the booleans and arrays on Postgres. A range now matches the leaves of the operand's own type and no
 * others, on every backend; `@lunora/hyperdrive`'s global-json-paths suite holds the same expectations for
 * Postgres and MySQL, so the ids below are the contract.
 */
const schema: SchemaLike = {
    tables: {
        mixes: {
            indexes: [],
            shape: { profile: { _meta: { column: { notNull: false }, shape: {} }, kind: "object" } },
        },
    },
};

let harness: ReturnType<typeof createSqliteExec>;

const seed = async () => {
    runShardMigrations(harness.sql, schema, { cdc: true });

    const writer = createShardContextDatabase({
        baselineSeq: () => undefined,
        broadcast: () => undefined,
        cdc: true,
        clock: () => 1_700_000_000_000,
        schema,
        sql: harness.sql,
    });

    for (const [id, profile] of MIX_ROWS) {
        // eslint-disable-next-line no-await-in-loop -- sequential inserts keep `_creationTime` in key order
        await writer.insert("mixes", { _id: id, profile }, { allowExplicitId: true });
    }

    return writer;
};

describe("a range over a path whose leaves mix types", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it.each(MIX_QUERIES)("finds %s", async (_label, where, expected) => {
        expect.assertions(2);

        const writer = await seed();
        const page = await writer.findMany("mixes", { where });

        expect(page.page.map((row) => String(row["_id"])).toSorted(byId)).toStrictEqual(expected);
        await expect(writer.count("mixes", where as never)).resolves.toBe(expected.length);
    });

    it.each(["asc", "desc"] as const)("pages through every type when ordering by the path, %s", async (sort) => {
        expect.assertions(1);

        const writer = await seed();
        const seen = await pageAllMixed((args) => writer.findMany("mixes", args), sort);

        // The seek continues the ORDER BY, which sorts every type together, so no row of any type is skipped or repeated.
        expect(seen.toSorted(byId)).toStrictEqual(MIX_ROWS.map(([id]) => id).toSorted(byId));
    });
});
