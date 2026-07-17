import { describe, expect, it } from "vitest";

import { defineSchema, defineTable, v } from "../src/index";

/**
 * `.source(...)` — external-source ingest declaration (plan 077). Orthogonal to
 * `.shardBy()`/`.global()`, implies `.externallyManaged()`, and fails fast on the
 * order-independent guards (`binding`/`query`). The tenant-scope + global
 * contradiction + unknown-mode checks need the fully-assembled table, so they
 * are enforced (and asserted) at `defineSchema` time, not on the builder.
 */

describe("defineTable().source", () => {
    it("records the external source and implies externallyManaged", () => {
        expect.assertions(3);

        const documents = defineTable({ body: v.string(), orgId: v.string() }).source({
            binding: "HYPERDRIVE_DOCS",
            query: "select id, body, org_id from documents",
        });

        expect(documents.externalSource).toEqual({ binding: "HYPERDRIVE_DOCS", query: "select id, body, org_id from documents" });
        expect(documents.isExternallyManaged).toBe(true);
        // Default routing is untouched — `.source()` is orthogonal to shard mode.
        expect(documents.shardMode).toEqual({ kind: "root" });
    });

    it("composes with .shardBy() for per-tenant sourced DOs", () => {
        expect.assertions(2);

        const tenantBy = (shardKey: string) => [shardKey];
        const documents = defineTable({ body: v.string(), orgId: v.string() })
            .shardBy("orgId")
            .source({ binding: "HD", query: "select id, body, org_id from documents where org_id = $1", tenantBy });

        expect(documents.shardMode).toEqual({ field: "orgId", kind: "shardBy" });
        expect(documents.externalSource?.tenantBy).toBe(tenantBy);
    });

    it("records the optional projection/cadence fields", () => {
        expect.assertions(1);

        const map = (row: Record<string, unknown>) => {
            return { title: row.title };
        };
        const documents = defineTable({ title: v.string() }).source({
            binding: "HD",
            columns: ["title"],
            idColumn: "uuid",
            map,
            mode: "full-pull",
            query: "select uuid, title from documents",
            refresh: { everyMs: 5000 },
        });

        expect(documents.externalSource).toEqual({
            binding: "HD",
            columns: ["title"],
            idColumn: "uuid",
            map,
            mode: "full-pull",
            query: "select uuid, title from documents",
            refresh: { everyMs: 5000 },
        });
    });

    it("is undefined when .source() is not called", () => {
        expect.assertions(1);

        expect(defineTable({ body: v.string() }).externalSource).toBeUndefined();
    });

    it("throws when the binding is empty", () => {
        expect.assertions(1);

        expect(() => defineTable({ body: v.string() }).source({ binding: "", query: "select 1" })).toThrow("`binding` is required");
    });

    it("throws when the query is empty", () => {
        expect.assertions(1);

        expect(() => defineTable({ body: v.string() }).source({ binding: "HD", query: "" })).toThrow("`query` is required");
    });
});

describe("defineSchema external-source validation", () => {
    it("throws on a sourced + .shardBy() table with no tenantBy (the tenant-isolation boundary)", () => {
        expect.assertions(1);

        expect(() =>
            defineSchema({
                documents: defineTable({ orgId: v.string(), title: v.string() })
                    .shardBy("orgId")
                    .source({ binding: "HD", query: "select id, title from documents" }),
            }),
        ).toThrow(/needs a `tenantBy` mapper/u);
    });

    it("accepts a sourced + .shardBy() table that has tenantBy", () => {
        expect.assertions(1);

        expect(() =>
            defineSchema({
                documents: defineTable({ orgId: v.string(), title: v.string() })
                    .shardBy("orgId")
                    .source({ binding: "HD", query: "select id, title, org_id from documents where org_id = $1", tenantBy: (key) => [key] }),
            }),
        ).not.toThrow();
    });

    it("accepts a sourced root (non-sharded) table without tenantBy", () => {
        expect.assertions(1);

        expect(() =>
            defineSchema({ documents: defineTable({ title: v.string() }).source({ binding: "HD", query: "select id, title from documents" }) }),
        ).not.toThrow();
    });

    it("throws on a sourced + .global() table (contradictory tiers)", () => {
        expect.assertions(1);

        expect(() =>
            defineSchema({
                documents: defineTable({ title: v.string() }).global().source({ binding: "HD", query: "select id, title from documents" }),
            }),
        ).toThrow(/cannot be both \.source\(\) and \.global\(\)/u);
    });

    it("accepts the explicit default mode: full-pull", () => {
        expect.assertions(1);

        expect(() =>
            defineSchema({
                documents: defineTable({ title: v.string() }).source({ binding: "HD", mode: "full-pull", query: "select id, title from documents" }),
            }),
        ).not.toThrow();
    });

    it("throws when an untyped caller passes an unknown mode", () => {
        expect.assertions(1);

        // A stray mode literal (`"incremental"` and `"full-pull"` are the only
        // valid ones) is a compile-time error for typed callers; the runtime guard
        // stays for untyped JS callers.
        const source = { binding: "HD", mode: "delta", query: "select id, title from documents" };

        expect(() =>
            defineSchema({
                documents: defineTable({ title: v.string() }).source(source as unknown as Parameters<ReturnType<typeof defineTable>["source"]>[0]),
            }),
        ).toThrow(/supported modes are "full-pull" \(default\) and "incremental"/u);
    });

    it("accepts mode: incremental with a cursor and a reconcile sweep", () => {
        expect.assertions(1);

        expect(() =>
            defineSchema({
                documents: defineTable({ title: v.string() }).source({
                    binding: "HD",
                    cursor: { column: "updated_at", query: "select id, title, updated_at from documents where updated_at >= $1" },
                    mode: "incremental",
                    query: "select id, title, updated_at from documents",
                    reconcileEveryMs: 3_600_000,
                }),
            }),
        ).not.toThrow();
    });

    it("accepts mode: incremental with a cursor and a soft-delete column", () => {
        expect.assertions(1);

        expect(() =>
            defineSchema({
                documents: defineTable({ title: v.string() }).source({
                    binding: "HD",
                    cursor: { column: "updated_at", query: "select id, title, updated_at, deleted_at from documents where updated_at >= $1" },
                    mode: "incremental",
                    query: "select id, title, updated_at from documents where deleted_at is null",
                    softDeleteColumn: "deleted_at",
                }),
            }),
        ).not.toThrow();
    });

    it("throws on mode: incremental without a cursor", () => {
        expect.assertions(1);

        expect(() =>
            defineSchema({
                documents: defineTable({ title: v.string() }).source({
                    binding: "HD",
                    mode: "incremental",
                    query: "select id, title from documents",
                    reconcileEveryMs: 3_600_000,
                }),
            }),
        ).toThrow(/is `mode: "incremental"` but has no `cursor`/u);
    });

    it("throws on mode: incremental with no delete-visibility path", () => {
        expect.assertions(1);

        expect(() =>
            defineSchema({
                documents: defineTable({ title: v.string() }).source({
                    binding: "HD",
                    cursor: { column: "updated_at", query: "select id, title, updated_at from documents where updated_at >= $1" },
                    mode: "incremental",
                    query: "select id, title, updated_at from documents",
                }),
            }),
        ).toThrow(/no delete-visibility path/u);
    });

    it("throws when an incremental-only knob is set on a full-pull source", () => {
        expect.assertions(1);

        expect(() =>
            defineSchema({
                documents: defineTable({ title: v.string() }).source({
                    binding: "HD",
                    query: "select id, title from documents",
                    reconcileEveryMs: 1000,
                }),
            }),
        ).toThrow(/only applies to incremental ingest/u);
    });
});
