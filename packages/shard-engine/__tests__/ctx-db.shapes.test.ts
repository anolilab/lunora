import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations, selectShapeMembers, selectShapeRows } from "../src/ctx-db";
import { readCdcChangeKeys, readCdcCursor } from "../src/ctx-db-cdc";
import { buildShapeDiff } from "../src/shape-diff";
import { ShapeDiffCache } from "../src/shape-diff-cache";
import messagesSchema from "./_helpers/messages-schema";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Shape membership over the real JSON-blob store. A shape's `effectiveWhere`
 * goes through the same `compileWhereSql` compiler as queries/RLS, so these
 * tests assert the seed snapshot (full rowset) and the per-flush membership
 * probe (which changed ids still match) line up with the predicate.
 */

let harness: ReturnType<typeof createSqliteExec>;

const setupWriter = (): DatabaseWriterLike => {
    runShardMigrations(harness.sql, messagesSchema, { cdc: true });

    return createShardContextDatabase({
        broadcast: () => undefined,
        cdc: true,
        clock: () => 1_700_000_000_000,
        schema: messagesSchema,
        sql: harness.sql,
    });
};

describe("ctx-db shape membership", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("seeds the full rowset matching the predicate, projected with _id", async () => {
        expect.assertions(3);

        const writer = setupWriter();

        await writer.insert("messages", { _id: "m1", authorId: "u1", channelId: "c1", text: "a" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "m2", authorId: "u2", channelId: "c1", text: "b" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "m3", authorId: "u1", channelId: "c2", text: "c" }, { allowExplicitId: true });

        const rows = selectShapeRows(harness.sql, "messages", { channelId: "c1" });

        expect(rows.map((row) => row.id).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["m1", "m2"]);

        const m1 = rows.find((row) => row.id === "m1");

        expect(m1?.doc["_id"]).toBe("m1");
        expect(m1?.doc["text"]).toBe("a");
    });

    it("returns every row when the predicate is empty", async () => {
        expect.assertions(1);

        const writer = setupWriter();

        await writer.insert("messages", { _id: "m1", authorId: "u1", channelId: "c1", text: "a" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "m2", authorId: "u2", channelId: "c2", text: "b" }, { allowExplicitId: true });

        expect(
            selectShapeRows(harness.sql, "messages", undefined)
                .map((row) => row.id)
                .toSorted((a, b) => a.localeCompare(b)),
        ).toStrictEqual(["m1", "m2"]);
    });

    it("probes membership of a changed-id set against the predicate", async () => {
        expect.assertions(2);

        const writer = setupWriter();

        await writer.insert("messages", { _id: "m1", authorId: "u1", channelId: "c1", text: "a" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "m2", authorId: "u2", channelId: "c2", text: "b" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "m3", authorId: "u1", channelId: "c1", text: "c" }, { allowExplicitId: true });

        // Of the three changed ids, only those in channel c1 are members.
        const members = selectShapeMembers(harness.sql, "messages", { channelId: "c1" }, ["m1", "m2", "m3"]);

        expect([...members.keys()].toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["m1", "m3"]);

        // A row that moved out of the set (patched to c2) is no longer a member.
        await writer.patch("m1", { channelId: "c2" });
        const after = selectShapeMembers(harness.sql, "messages", { channelId: "c1" }, ["m1", "m3"]);

        expect([...after.keys()]).toStrictEqual(["m3"]);
    });

    it("returns each member's current document alongside its key", async () => {
        expect.assertions(2);

        const writer = setupWriter();

        await writer.insert("messages", { _id: "m1", authorId: "u1", channelId: "c1", text: "a" }, { allowExplicitId: true });

        // The membership probe IS the diff's enrichment read: a member comes back
        // with the value the predicate admits, so the poke never has to source it
        // from the op-log's post-image.
        expect(selectShapeMembers(harness.sql, "messages", { channelId: "c1" }, ["m1"]).get("m1")).toMatchObject({ _id: "m1", text: "a" });

        // And it is the CURRENT value, not the one the op that changed it carried.
        await writer.patch("m1", { text: "b" });

        expect(selectShapeMembers(harness.sql, "messages", { channelId: "c1" }, ["m1"]).get("m1")).toMatchObject({ text: "b" });
    });

    /**
     * A hard delete followed by a re-insert of the same `_id` inside ONE poke
     * window must still tell the client to drop the key.
     *
     * `readCdcChangeKeys` groups by id and reports only the op that supplied
     * `MAX(seq)`, so `delete@N` + `insert@N+1` used to collapse to `insert` — and
     * `buildShapeDiff` skips a non-member whose op is `insert` on the ground that
     * such a row "was never replicated to anyone". That ground does not hold for
     * a key that HAD been replicated before the delete, so the client went on
     * rendering the pre-delete row forever. Narrowed in practice by the default
     * `delete()` being a soft delete recorded as `update`; this fixture uses a
     * table with no soft-delete marker, which is the hard-delete path.
     *
     * Scaled past a single row on purpose: the naive fix (drop the `insert`
     * exemption and always emit a delete for a non-member) would pass a one-row
     * test while spamming every subscriber of a busy table with a no-op delete
     * per unrelated insert. The `never-matched` cohort below is what fails it.
     */
    it("emits a delete when a replicated key is hard-deleted and re-inserted out of the shape in one window", async () => {
        expect.assertions(5);

        const writer = setupWriter();

        // 40 replicated members, plus a durable bystander in another channel.
        for (let index = 0; index < 40; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential seeding: the assertions read the changelog cursor these writes advance
            await writer.insert(
                "messages",
                { _id: `m${String(index)}`, authorId: "u1", channelId: "c1", text: `t${String(index)}` },
                { allowExplicitId: true },
            );
        }

        const seedCursor = readCdcCursor(harness.sql);

        // Inside one poke window:
        // - `m0` is hard-deleted and re-inserted OUT of the shape.
        // - `m1` is hard-deleted and re-inserted back INTO it.
        // - 20 brand-new rows land in another channel and were never replicated.
        await writer.delete("m0");
        await writer.insert("messages", { _id: "m0", authorId: "u1", channelId: "c2", text: "t0" }, { allowExplicitId: true });
        await writer.delete("m1");
        await writer.insert("messages", { _id: "m1", authorId: "u1", channelId: "c1", text: "t1-again" }, { allowExplicitId: true });

        for (let index = 0; index < 20; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential: these are the no-op-delete spam cohort the exemption protects
            await writer.insert(
                "messages",
                { _id: `n${String(index)}`, authorId: "u1", channelId: "c2", text: `n${String(index)}` },
                { allowExplicitId: true },
            );
        }

        const upTo = readCdcCursor(harness.sql);
        const ops = buildShapeDiff(harness.sql, { effectiveWhere: { channelId: "c1" }, table: "messages" }, seedCursor, upTo, new ShapeDiffCache());

        // `m0` left the shape and must be dropped by the client…
        expect(ops.filter((op) => op.op === "delete").map((op) => op.key)).toStrictEqual(["m0"]);
        // …`m1` is still a member and ships its current value…
        expect(ops.find((op) => op.key === "m1")?.value).toMatchObject({ text: "t1-again" });
        // …and the 20 rows that never matched produce nothing at all.
        expect(ops.map((op) => op.key).filter((key) => key.startsWith("n"))).toStrictEqual([]);

        // The mechanism behind the first assertion: a key touched more than once
        // in the window is never reported as an `insert`, which is what keeps it
        // out of `buildShapeDiff`'s never-replicated exemption.
        const changed = readCdcChangeKeys(harness.sql, "messages", seedCursor, upTo);

        expect(changed.find((key) => key.id === "m0")?.op).toBe("update");
        expect(changed.find((key) => key.id === "n0")?.op).toBe("insert");
    });

    it("short-circuits an empty id set to an empty membership", () => {
        expect.assertions(1);

        setupWriter();

        expect(selectShapeMembers(harness.sql, "messages", { channelId: "c1" }, []).size).toBe(0);
    });
});
