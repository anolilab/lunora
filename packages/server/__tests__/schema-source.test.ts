import { describe, expect, it } from "vitest";

import { defineTable, v } from "../src/index";

/**
 * `.source(...)` — external-source ingest declaration (plan 077). Orthogonal to
 * `.shardBy()`/`.global()`, implies `.externallyManaged()`, and fails fast on the
 * order-independent guards (`binding`/`query`). The tenant-scope + global
 * contradiction checks live in the advisor lints (they need the final IR), so they
 * are not asserted here.
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
            mode: "incremental",
            query: "select uuid, title from documents",
            reconcileEveryMs: 60_000,
            refresh: { everyMs: 5000 },
        });

        expect(documents.externalSource).toEqual({
            binding: "HD",
            columns: ["title"],
            idColumn: "uuid",
            map,
            mode: "incremental",
            query: "select uuid, title from documents",
            reconcileEveryMs: 60_000,
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
