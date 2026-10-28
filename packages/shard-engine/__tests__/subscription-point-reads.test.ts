/**
 * By-id reads narrow a live query to the rows it named.
 *
 * A subscription that only `get`s rows depends on those rows and nothing else,
 * so a write to any other row of the table must not re-run it — on a table with
 * declared indexes and on one without. The other half matters more: a write to
 * a row it DID read, by patch, replace or delete, must still re-run it, and so
 * must anything a non-point read on the same table could see.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import { createReadFootprint } from "../src/read-footprint";
import type { ChangedKeys, SubscriptionReadFootprint } from "../src/subscription-range-gate";
import { recordChangedKeys, writeTouchesMemo } from "../src/subscription-range-gate";
import createSqliteExec from "./_helpers/node-sqlite";

const schema: SchemaLike = {
    tables: {
        messages: {
            indexes: [{ fields: ["channel"], name: "by_channel" }],
            shape: { body: { kind: "string" }, channel: { kind: "string" } },
        },
        notes: {
            indexes: [],
            shape: { body: { kind: "string" } },
        },
    },
};

let harness: ReturnType<typeof createSqliteExec>;

/** A writer whose broadcasts accumulate into one refresh batch, as `recordChangedTable` does. */
const batchWriter = (): { batch: () => { changed: Set<string>; changedKeys: ChangedKeys | undefined }; database: DatabaseWriterLike } => {
    const changed = new Set<string>();
    let changedKeys: ChangedKeys | undefined;

    const database = createShardContextDatabase({
        broadcast: (delta) => {
            changed.add(delta.table);
            changedKeys = recordChangedKeys(changedKeys, delta.table, delta.indexKeys);
        },
        clock: () => 1_700_000_000_000,
        schema,
        sql: harness.sql,
    });

    return {
        batch: () => {
            return { changed, changedKeys };
        },
        database,
    };
};

/** Run `read` the way `executeSubscription` does and return the memo it would store. */
const subscribe = async (read: (database: DatabaseWriterLike) => Promise<unknown>): Promise<SubscriptionReadFootprint> => {
    const footprint = createReadFootprint();

    await read(createShardContextDatabase({ onRead: footprint.onRead, onReadRange: footprint.onReadRange, schema, sql: harness.sql }));

    const ranges = footprint.ranges();

    return { ...(ranges === undefined ? {} : { ranges }), tables: footprint.tables };
};

/** Would the writes `write` performs re-run a subscription with `memo`? */
const reruns = async (memo: SubscriptionReadFootprint, write: (database: DatabaseWriterLike) => Promise<unknown>): Promise<boolean> => {
    const { batch, database } = batchWriter();

    await write(database);

    const { changed, changedKeys } = batch();

    return writeTouchesMemo(memo, changed, changedKeys);
};

describe("subscription point reads", () => {
    let seed: DatabaseWriterLike;

    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, schema);
        seed = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
    });

    afterEach(() => {
        harness.close();
    });

    it.each(["messages", "notes"])("a get on %s re-runs only for writes to the row it read", async (table) => {
        expect.assertions(6);

        const idA = await seed.insert(table, { body: "a", channel: "c1" });
        const idB = await seed.insert(table, { body: "b", channel: "c1" });
        const memo = await subscribe(async (database) => database.get(table, idA));

        await expect(reruns(memo, async (database) => database.patch(table, idB, { body: "b2" }))).resolves.toBe(false);
        await expect(reruns(memo, async (database) => database.insert(table, { body: "new", channel: "c1" }))).resolves.toBe(false);
        await expect(reruns(memo, async (database) => database.delete(table, idB))).resolves.toBe(false);
        await expect(reruns(memo, async (database) => database.patch(table, idA, { body: "a2" }))).resolves.toBe(true);
        await expect(reruns(memo, async (database) => database.replace(table, idA, { body: "a3", channel: "c2" }))).resolves.toBe(true);
        await expect(reruns(memo, async (database) => database.delete(table, idA))).resolves.toBe(true);
    });

    it("many gets narrow to exactly the rows read", async () => {
        expect.assertions(3);

        const ids: string[] = [];

        for (let index = 0; index < 50; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential seeding keeps the id list ordered
            ids.push(await seed.insert("notes", { body: String(index) }));
        }

        const read = ids.filter((_, index) => index % 2 === 0);
        const memo = await subscribe(async (database) => Promise.all(read.map(async (id) => database.get("notes", id))));

        await expect(reruns(memo, async (database) => database.patch("notes", ids[1] as string, { body: "x" }))).resolves.toBe(false);
        await expect(reruns(memo, async (database) => database.patch("notes", ids[48] as string, { body: "x" }))).resolves.toBe(true);
        // A bulk write that hits one read row among many unread ones.
        await expect(
            reruns(memo, async (database) => {
                for (const [index, id] of ids.entries()) {
                    if (index % 2 === 1 || index === 24) {
                        // eslint-disable-next-line no-await-in-loop -- one batch, written row by row
                        await database.patch("notes", id, { body: "y" });
                    }
                }
            }),
        ).resolves.toBe(true);
    });

    it("lookupById narrows like get", async () => {
        expect.assertions(2);

        const idA = await seed.insert("notes", { body: "a" });
        const idB = await seed.insert("notes", { body: "b" });
        const memo = await subscribe(async (database) => database.lookupById?.(idA, "notes"));

        await expect(reruns(memo, async (database) => database.patch("notes", idB, { body: "b2" }))).resolves.toBe(false);
        await expect(reruns(memo, async (database) => database.patch("notes", idA, { body: "a2" }))).resolves.toBe(true);
    });

    it("a get of a missing id re-runs when that id is written", async () => {
        expect.assertions(3);

        const memo = await subscribe(async (database) => database.get("notes", "missing-id"));

        expect(memo.tables.has("notes")).toBe(true);
        await expect(reruns(memo, async (database) => database.insert("notes", { body: "other" }))).resolves.toBe(false);
        await expect(reruns(memo, async (database) => database.insert("notes", { _id: "missing-id", body: "late" }, { allowExplicitId: true }))).resolves.toBe(
            true,
        );
    });

    it.each([["notes"], [undefined]])("a lookupById miss (table %s) beside a get re-runs when that id is written", async (expectedTable) => {
        expect.assertions(3);

        const idA = await seed.insert("notes", { body: "a" });
        const memo = await subscribe(async (database) => {
            await database.get("notes", idA);

            return database.lookupById?.("missing-id", expectedTable);
        });

        await expect(reruns(memo, async (database) => database.insert("notes", { body: "other" }))).resolves.toBe(false);
        await expect(reruns(memo, async (database) => database.insert("notes", { _id: "missing-id", body: "late" }, { allowExplicitId: true }))).resolves.toBe(
            true,
        );
        await expect(
            reruns(memo, async (database) => database.insert("messages", { _id: "missing-id", body: "late", channel: "c1" }, { allowExplicitId: true })),
        ).resolves.toBe(expectedTable === undefined);
    });

    it("a patch carries one id key for its before and after images", async () => {
        expect.assertions(1);

        const idA = await seed.insert("messages", { body: "a", channel: "c1" });
        const keys: string[] = [];
        const database = createShardContextDatabase({
            broadcast: (delta) => {
                keys.push(...(delta.indexKeys ?? []).filter((entry) => entry.index === "!id").map((entry) => entry.key));
            },
            clock: () => 1_700_000_000_000,
            schema,
            sql: harness.sql,
        });

        await database.patch("messages", idA, { channel: "c2" });

        expect(keys).toStrictEqual([idA]);
    });

    it("a get mixed with a predicated read of the same table stays whole-table", async () => {
        expect.assertions(2);

        const idA = await seed.insert("messages", { body: "a", channel: "c1" });

        await seed.insert("messages", { body: "b", channel: "c2" });

        const memo = await subscribe(async (database) => {
            await database.get("messages", idA);

            return database.findMany("messages", { where: { channel: "c2" } });
        });

        expect(memo.ranges?.has("messages") ?? false).toBe(false);
        // A new matching row is invisible to the get's slice but not to the findMany.
        await expect(reruns(memo, async (database) => database.insert("messages", { body: "c", channel: "c2" }))).resolves.toBe(true);
    });
});
