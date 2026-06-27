import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { defineTable } from "../src/schema";

/**
 * `.softDelete()` records the marker config on `softDeleteMode` (named so it
 * doesn't collide with the fluent method, like `shardBy()`/`shardMode`) and
 * injects the nullable marker column into the table shape so codegen emits it.
 */
describe("defineTable().softDelete()", () => {
    it("defaults the marker column to deletedAt and injects it into the shape", () => {
        expect.assertions(3);

        const table = defineTable({ title: v.string() }).softDelete();

        expect(table.softDeleteMode).toStrictEqual({ field: "deletedAt" });
        expect(Object.keys(table.shape).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["deletedAt", "title"]);
        // The injected column is optional (absent on a live row). Cast: the
        // injection is a runtime effect, so the static `Shape` type omits it.
        expect((table.shape as Record<string, { kind: string }>)["deletedAt"]?.kind).toBe("optional");
    });

    it("honors a custom marker field name", () => {
        expect.assertions(2);

        const table = defineTable({ title: v.string() }).softDelete({ field: "removedAt" });

        expect(table.softDeleteMode).toStrictEqual({ field: "removedAt" });
        expect("removedAt" in table.shape).toBe(true);
    });

    it("does not overwrite a user-declared marker column", () => {
        expect.assertions(1);

        const declared = v.optional(v.number());
        const table = defineTable({ deletedAt: declared, title: v.string() }).softDelete();

        // The user's own validator instance wins.
        expect(table.shape["deletedAt"]).toBe(declared);
    });

    it("is absent on a table without .softDelete()", () => {
        expect.assertions(1);

        const table = defineTable({ title: v.string() });

        expect(table.softDeleteMode).toBeUndefined();
    });
});
