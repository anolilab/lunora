import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations, selectShapeMemberIds, selectShapeRows } from "../src/ctx-db";
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
        const members = selectShapeMemberIds(harness.sql, "messages", { channelId: "c1" }, ["m1", "m2", "m3"]);

        expect([...members].toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["m1", "m3"]);

        // A row that moved out of the set (patched to c2) is no longer a member.
        await writer.patch("m1", { channelId: "c2" });
        const after = selectShapeMemberIds(harness.sql, "messages", { channelId: "c1" }, ["m1", "m3"]);

        expect([...after]).toStrictEqual(["m3"]);
    });

    it("short-circuits an empty id set to an empty membership", () => {
        expect.assertions(1);

        setupWriter();

        expect(selectShapeMemberIds(harness.sql, "messages", { channelId: "c1" }, []).size).toBe(0);
    });
});
