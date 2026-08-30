import { describe, expect, it } from "vitest";

import type { SchemaLike } from "../src/ctx-db";
import { createShardCtxDb } from "../src/ctx-db";
import { runShardMigrations } from "../src/ctx-db-migrations";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * `findFirst` reads `page[0]` and drops the envelope, so the `continueCursor`
 * `findMany` built for it was an `encodeWire` + `JSON.stringify` + base64 spent
 * on a value nobody reads. `omitContinueCursor` skips it.
 *
 * The risk the flag introduces is that `continueCursor` becomes `null` where a
 * next page genuinely exists, so these pin both halves: `findFirst` still
 * returns the right ROW, and a normal `findMany` — which is every paginating
 * caller — still gets its cursor.
 */

const schema = {
    tables: {
        messages: {
            indexes: [{ fields: ["channelId"], name: "by_channel" }],
            shape: { body: { kind: "string" }, channelId: { kind: "string" } },
        },
    },
} as unknown as SchemaLike;

const seed = async (): Promise<ReturnType<typeof createShardCtxDb>> => {
    const harness = createSqliteExec();

    runShardMigrations(harness.sql, schema);

    const db = createShardCtxDb({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });

    for (let index = 0; index < 5; index += 1) {
        // Sequential on purpose: the paging assertions below depend on these ids
        // landing in this order, which a parallel insert would not guarantee.
        // eslint-disable-next-line no-await-in-loop -- see above
        await db.insert("messages", { _id: `m${String(index)}`, body: `b${String(index)}`, channelId: "c1" }, { allowExplicitId: true });
    }

    return db;
};

describe("omitContinueCursor", () => {
    it("still returns the first matching row", async () => {
        expect.assertions(1);

        const db = await seed();

        const row = await db.findFirst("messages", { where: { channelId: "c1" } });

        expect(row?.["_id"]).toBe("m0");
    });

    it("leaves a paginating findMany its cursor", async () => {
        expect.hasAssertions();

        // The flag must not leak to ordinary reads: this is the caller that would
        // silently page nowhere if the default flipped.
        const db = await seed();
        const page = await db.findMany("messages", { limit: 2, where: { channelId: "c1" } });

        expect(page.page).toHaveLength(2);
        expect(page.isDone).toBe(false);
        expect(page.continueCursor).toStrictEqual(expect.any(String));
    });

    it("resumes correctly from the cursor a normal read returned", async () => {
        expect.assertions(2);

        // End to end: the cursor still addresses the next page, so skipping it for
        // findFirst has not changed what a real pager gets.
        const db = await seed();
        const first = await db.findMany("messages", { limit: 2, where: { channelId: "c1" } });
        const second = await db.findMany("messages", { cursor: first.continueCursor, limit: 2, where: { channelId: "c1" } });

        expect(first.page.map((row) => row["_id"])).toStrictEqual(["m0", "m1"]);
        expect(second.page.map((row) => row["_id"])).toStrictEqual(["m2", "m3"]);
    });

    it("reports isDone honestly even with the cursor omitted", async () => {
        expect.assertions(2);

        // `isDone` is the field a caller should read for "is there more", and it is
        // deliberately unaffected — so the flag degrades one field, not two.
        const db = await seed();
        const page = await db.findMany("messages", { limit: 2, omitContinueCursor: true, where: { channelId: "c1" } });

        expect(page.isDone).toBe(false);
        expect(page.continueCursor).toBeNull();
    });
});
