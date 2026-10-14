import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { defineTable } from "../src/schema";

const keysOf = (table: { shape: Record<string, unknown> }): string[] => Object.keys(table.shape).toSorted((a, b) => a.localeCompare(b));

/**
 * `.timestamps()` injects a defaulted, recomputed-on-update epoch column so a table tracks its last change
 * without hand-writing the `$onUpdateFn` chain. The generated types and the engines read the same column.
 */
describe("defineTable().timestamps()", () => {
    it("injects updatedAt as a timestamp column", () => {
        expect.assertions(2);

        const table = defineTable({ title: v.string() }).timestamps();

        expect(keysOf(table)).toStrictEqual(["title", "updatedAt"]);
        // That it also defaults on insert and restamps on update is pinned by the codegen equivalence test and the engine tests.
        expect((table.shape as unknown as Record<string, { kind: string }>)["updatedAt"]?.kind).toBe("timestamp");
    });

    it("honors a custom field name", () => {
        expect.assertions(2);

        const table = defineTable({ title: v.string() }).timestamps({ field: "modifiedAt" });

        expect("modifiedAt" in table.shape).toBe(true);
        expect("updatedAt" in table.shape).toBe(false);
    });

    it("keeps a column the author declared when it already restamps on update", () => {
        expect.assertions(1);

        const declared = v
            .timestamp()
            .defaultNow()
            .$onUpdateFn(() => 1);
        const table = defineTable({ title: v.string(), updatedAt: declared }).timestamps();

        expect(table.shape["updatedAt"]).toBe(declared);
    });

    it.each([
        ["one that does not restamp", v.timestamp().defaultNow()],
        ["one with no insert default", v.timestamp().$onUpdateFn(() => 1)],
        ["one that is not a timestamp", v.string().$onUpdateFn(() => "now")],
    ])("refuses a declared column that breaks the contract (%s), instead of silently doing nothing", (_label, declared) => {
        expect.assertions(1);

        expect(() => defineTable({ title: v.string(), updatedAt: declared }).timestamps()).toThrow("already declares it");
    });

    it("composes with softDelete on different fields", () => {
        expect.assertions(1);

        expect(keysOf(defineTable({ title: v.string() }).softDelete().timestamps())).toStrictEqual(["deletedAt", "title", "updatedAt"]);
    });

    it("refuses to be called twice, or to share softDelete's field, in either order", () => {
        expect.assertions(3);

        expect(() => defineTable({ title: v.string() }).timestamps().timestamps({ field: "other" })).toThrow("called twice");
        expect(() => defineTable({ title: v.string() }).softDelete({ field: "stamp" }).timestamps({ field: "stamp" })).toThrow("both use");
        expect(() => defineTable({ title: v.string() }).timestamps({ field: "stamp" }).softDelete({ field: "stamp" })).toThrow("both use");
    });
});
