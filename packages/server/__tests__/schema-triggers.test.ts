import { describe, expect, it, vi } from "vitest";

import { defineTable, v } from "../src/index";

describe("defineTable().triggers", () => {
    it("table without .triggers exposes an empty triggerMap", () => {
        expect.assertions(1);

        const messages = defineTable({ body: v.string() });

        expect(messages.triggerMap).toEqual({});
    });

    it("records correct timing+op descriptors per builder method", () => {
        expect.assertions(6);

        const noop = vi.fn<() => void>();
        const messages = defineTable({ body: v.string(), locked: v.boolean() }).triggers((t) => {
            return {
                auditDelete: t.afterDelete(noop),
                auditInsert: t.afterInsert(noop),
                auditUpdate: t.afterUpdate(noop),
                guardDelete: t.beforeDelete(noop),
                guardInsert: t.beforeInsert(noop),
                guardUpdate: t.beforeUpdate(noop),
            };
        });

        expect(messages.triggerMap.guardInsert).toMatchObject({ op: "insert", timing: "before" });
        expect(messages.triggerMap.auditInsert).toMatchObject({ op: "insert", timing: "after" });
        expect(messages.triggerMap.guardUpdate).toMatchObject({ op: "update", timing: "before" });
        expect(messages.triggerMap.auditUpdate).toMatchObject({ op: "update", timing: "after" });
        expect(messages.triggerMap.guardDelete).toMatchObject({ op: "delete", timing: "before" });
        expect(messages.triggerMap.auditDelete).toMatchObject({ op: "delete", timing: "after" });
    });

    it("stores the supplied handler on each descriptor", () => {
        expect.assertions(1);

        const handler = vi.fn<() => void>();
        const messages = defineTable({ body: v.string() }).triggers((t) => {
            return {
                log: t.afterInsert(handler),
            };
        });

        expect(messages.triggerMap.log!.handler).toBe(handler);
    });

    it("multiple named handlers for the same lifecycle point coexist", () => {
        expect.assertions(3);

        const messages = defineTable({ authorId: v.id("users"), body: v.string() }).triggers((t) => {
            return {
                audit: t.afterInsert(vi.fn()),
                bumpCount: t.afterInsert(vi.fn()),
            };
        });

        expect(Object.keys(messages.triggerMap)).toEqual(["audit", "bumpCount"]);
        expect(messages.triggerMap.audit).toMatchObject({ op: "insert", timing: "after" });
        expect(messages.triggerMap.bumpCount).toMatchObject({ op: "insert", timing: "after" });
    });

    it(".triggers returns the same builder instance", () => {
        expect.assertions(1);

        const builder = defineTable({ body: v.string() });
        const chained = builder.triggers((t) => {
            return { log: t.afterInsert(vi.fn()) };
        });

        expect(chained).toBe(builder);
    });

    it("coexists with .relations() and .index() on the same table", () => {
        expect.assertions(3);

        const messages = defineTable({ authorId: v.id("users"), body: v.string() })
            .index("by_author", ["authorId"])
            .relations((r) => {
                return { author: r.one("users", { field: "authorId" }) };
            })
            .triggers((t) => {
                return { guard: t.beforeDelete(vi.fn()) };
            });

        expect(messages.indexes).toHaveLength(1);
        expect(Object.keys(messages.relationMap)).toEqual(["author"]);
        expect(Object.keys(messages.triggerMap)).toEqual(["guard"]);
    });
});
