import { describe, expect, test, vi } from "vitest";

import { defineTable, v } from "../src/index.js";

describe("defineTable().triggers", () => {
    test("table without .triggers exposes an empty triggerMap", () => {
        const messages = defineTable({ body: v.string() });

        expect(messages.triggerMap).toEqual({});
    });

    test("records correct timing+op descriptors per builder method", () => {
        const noop = vi.fn();
        const messages = defineTable({ body: v.string(), locked: v.boolean() }).triggers((t) => ({
            auditDelete: t.afterDelete(noop),
            auditInsert: t.afterInsert(noop),
            auditUpdate: t.afterUpdate(noop),
            guardDelete: t.beforeDelete(noop),
            guardInsert: t.beforeInsert(noop),
            guardUpdate: t.beforeUpdate(noop),
        }));

        expect(messages.triggerMap.guardInsert).toMatchObject({ op: "insert", timing: "before" });
        expect(messages.triggerMap.auditInsert).toMatchObject({ op: "insert", timing: "after" });
        expect(messages.triggerMap.guardUpdate).toMatchObject({ op: "update", timing: "before" });
        expect(messages.triggerMap.auditUpdate).toMatchObject({ op: "update", timing: "after" });
        expect(messages.triggerMap.guardDelete).toMatchObject({ op: "delete", timing: "before" });
        expect(messages.triggerMap.auditDelete).toMatchObject({ op: "delete", timing: "after" });
    });

    test("stores the supplied handler on each descriptor", () => {
        const handler = vi.fn();
        const messages = defineTable({ body: v.string() }).triggers((t) => ({
            log: t.afterInsert(handler),
        }));

        expect(messages.triggerMap.log!.handler).toBe(handler);
    });

    test("multiple named handlers for the same lifecycle point coexist", () => {
        const messages = defineTable({ authorId: v.id("users"), body: v.string() }).triggers((t) => ({
            audit: t.afterInsert(vi.fn()),
            bumpCount: t.afterInsert(vi.fn()),
        }));

        expect(Object.keys(messages.triggerMap)).toEqual(["audit", "bumpCount"]);
        expect(messages.triggerMap.audit).toMatchObject({ op: "insert", timing: "after" });
        expect(messages.triggerMap.bumpCount).toMatchObject({ op: "insert", timing: "after" });
    });

    test(".triggers returns the same builder instance", () => {
        const builder = defineTable({ body: v.string() });
        const chained = builder.triggers((t) => ({ log: t.afterInsert(vi.fn()) }));

        expect(chained).toBe(builder);
    });

    test("coexists with .relations() and .index() on the same table", () => {
        const messages = defineTable({ authorId: v.id("users"), body: v.string() })
            .index("by_author", ["authorId"])
            .relations((r) => ({ author: r.one("users", { field: "authorId" }) }))
            .triggers((t) => ({ guard: t.beforeDelete(vi.fn()) }));

        expect(messages.indexes).toHaveLength(1);
        expect(Object.keys(messages.relationMap)).toEqual(["author"]);
        expect(Object.keys(messages.triggerMap)).toEqual(["guard"]);
    });
});
