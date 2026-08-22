import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { defineSchema, defineTable } from "../src/schema";

/**
 * `.commitOrdered()` records its opt-in on `commitOrderedMode` (named so it
 * doesn't collide with the fluent method, like `shardBy()`/`shardMode`).
 *
 * Unlike `.softDelete()`, it injects nothing into the shape: `_commitSeq` is
 * runtime-minted like `_id`/`_creationTime`, and codegen renders it straight
 * onto `Doc_*`. The one guard worth a test is the `.global()` rejection, which
 * has to fire regardless of chain order — the value is allocated inside the
 * shard's write transaction, and a D1-backed table does not share it.
 */
describe("defineTable().commitOrdered()", () => {
    it("records the opt-in and leaves the shape alone", () => {
        expect.assertions(2);

        const table = defineTable({ title: v.string() }).commitOrdered();

        expect(table.commitOrderedMode).toBe(true);
        expect(Object.keys(table.shape)).toStrictEqual(["title"]);
    });

    it("is absent on a table that never opted in", () => {
        expect.assertions(1);

        expect(defineTable({ title: v.string() }).commitOrderedMode).toBe(false);
    });

    it("rejects .global() in either chain order", () => {
        expect.assertions(2);

        expect(() => defineSchema({ feed: defineTable({ title: v.string() }).global().commitOrdered() })).toThrow(/both \.global\(\) and \.commitOrdered\(\)/u);
        expect(() => defineSchema({ feed: defineTable({ title: v.string() }).commitOrdered().global() })).toThrow(/both \.global\(\) and \.commitOrdered\(\)/u);
    });

    it("rejects an index over _commitSeq on a table that never opted in", () => {
        expect.assertions(1);

        // `_commitSeq` is in `SYSTEM_INDEX_FIELDS`, so the shape check accepts it
        // anywhere — but unlike `_id`/`_creationTime`, only a `.commitOrdered()`
        // table's rows carry it. Left unguarded this index builds, validates, and
        // matches nothing: a dead index that reads as a working one.
        expect(() =>
            defineSchema({
                feed: defineTable({ title: v.string() }).index("by_commit", ["_commitSeq"]),
            }),
        ).toThrow(/is not \.commitOrdered\(\)/u);
    });

    it("rejects _commitSeq as part of a compound index on a table that never opted in", () => {
        expect.assertions(1);

        expect(() =>
            defineSchema({
                feed: defineTable({ deskId: v.string(), title: v.string() }).index("by_desk_commit", ["deskId", "_commitSeq"]),
            }),
        ).toThrow(/is not \.commitOrdered\(\)/u);
    });

    it("allows an index over _commitSeq once the table opts in", () => {
        expect.assertions(1);

        // The whole point of putting it in `SYSTEM_INDEX_FIELDS`: paging a
        // changefeed wants the index.
        expect(() =>
            defineSchema({
                feed: defineTable({ title: v.string() }).commitOrdered().index("by_commit", ["_commitSeq"]),
            }),
        ).not.toThrow();
    });

    it("still allows _creationTime and _id indexes on any table", () => {
        expect.assertions(1);

        // Those two are on every row, so they carry no such precondition — the
        // guard must not have widened to all system fields.
        expect(() =>
            defineSchema({
                feed: defineTable({ title: v.string() }).index("by_created", ["_creationTime"]).index("by_id", ["_id"]),
            }),
        ).not.toThrow();
    });

    it("allows .commitOrdered() alongside .shardBy() and .softDelete()", () => {
        expect.assertions(1);

        expect(() =>
            defineSchema({
                feed: defineTable({ tenantId: v.string(), title: v.string() }).shardBy("tenantId").softDelete().commitOrdered(),
            }),
        ).not.toThrow();
    });
});
