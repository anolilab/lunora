/**
 * A failed many-to-many `set` leaves the join rows as they were, on a real Durable Object.
 *
 * A mutation's atomicity is the Durable Object's `state.storage.transaction`, which rolls back when the closure
 * throws. `set` releases `p1`'s link to `t1` and then inserts the link to the blocked `t3`, whose `beforeInsert`
 * trigger throws, so the delete has already happened when the write fails. Inside the transaction it must come back;
 * outside one (an action) it stays gone, which is what shows this test can fail.
 *
 * The nested-write composition lives in `@lunora/server`, which `@lunora/do` does not depend on, so it is imported
 * by path: it only needs the engine writer this test builds.
 */
import type { SchemaLike } from "@lunora/shard-engine";
import { createShardCtxDb, runShardMigrations } from "@lunora/shard-engine";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { THROUGH_SCHEMA } from "../../../../shared/through-cases";
import { patchWithRelations } from "../../../server/src/relation-writes";

const schema = {
    tables: {
        ...THROUGH_SCHEMA.tables,
        post_tags: {
            ...THROUGH_SCHEMA.tables.post_tags,
            triggerMap: {
                rejectBlocked: {
                    handler: (_context: unknown, event: { doc: Record<string, unknown> }) => {
                        if (event.doc["tagId"] === "t3") {
                            throw new Error("tag is blocked");
                        }
                    },
                    op: "insert",
                    timing: "before",
                },
            },
        },
    },
} as unknown as SchemaLike;

const linkedTags = async (db: ReturnType<typeof createShardCtxDb>): Promise<string[]> => {
    const { page } = await db.findMany("post_tags", { where: { postId: "p1" } });

    return page.map((row) => String(row["tagId"])).toSorted((left, right) => left.localeCompare(right));
};

describe("a failed many-to-many set on workerd", () => {
    it.each([
        { name: "inside a storage transaction it rolls back to the links it started with", transactional: true, remaining: ["t1", "t2"] },
        { name: "outside one it leaves the release in place", transactional: false, remaining: ["t2"] },
    ])("$name", async ({ remaining, transactional }) => {
        expect.assertions(2);

        const stub = env.SHARD.get(env.SHARD.idFromName(`through-rollback-${String(transactional)}`));

        await runInDurableObject(stub, async (_instance, state) => {
            const sql = { exec: state.storage.sql.exec.bind(state.storage.sql) } as never;

            runShardMigrations(sql, schema);

            // The engine's gate only asks whether a transaction is open; here the transaction is the closure below, or the lack of one.
            const db = createShardCtxDb({ inTransaction: () => true, schema, sql });
            const infos = db.relationWrites?.["posts"];

            await db.insert("posts", { _id: "p1", title: "alpha" }, { allowExplicitId: true });

            for (const tag of ["t1", "t2", "t3"]) {
                // eslint-disable-next-line no-await-in-loop -- sequential seed
                await db.insert("tags", { _id: tag, label: tag }, { allowExplicitId: true });
            }

            await patchWithRelations(db as never, "posts", infos, "p1", { tags: { connect: ["t1", "t2"] } });

            const failingSet = async (): Promise<void> => patchWithRelations(db as never, "posts", infos, "p1", { tags: { set: ["t2", "t3"] } });

            await expect(transactional ? state.storage.transaction(failingSet) : failingSet()).rejects.toThrow(/blocked/u);
            await expect(linkedTags(db)).resolves.toStrictEqual(remaining);
        });
    });
});
