import type { SchemaLike } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { byId, MIX_QUERIES, MIX_ROWS, pageAllMixed } from "../../shard-engine/__tests__/_helpers/mixed-type-paths";
import { createSqlCtxDb } from "../src/ctx-db";
import { runSqlGlobalTableMigrations } from "../src/ctx-db-global-provisioning";
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

describe("a range over a path whose leaves mix types", () => {
    let harness: ReturnType<typeof createSqliteHarness>;
    const dialect = makeSqliteDialect();

    const seed = async () => {
        await runSqlGlobalTableMigrations(harness.exec, schema, dialect);

        const writer = createSqlCtxDb({ clock: () => 1_700_000_000_000, dialect, exec: harness.exec, schema });

        for (const [id, profile] of MIX_ROWS) {
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

        expect(seen.toSorted(byId)).toStrictEqual(MIX_ROWS.map(([id]) => id).toSorted(byId));
    });
});
