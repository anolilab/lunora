import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import externalSourceOnGlobal from "../src/lints/static/external-source-on-global";
import externalSourceUnscoped from "../src/lints/static/external-source-unscoped";

/**
 * Tenant-scope + tier-contradiction enforcement for `.source(...)` (plan 077),
 * driven through `fromServerSchema` so the runtime feeder mapping of
 * `externalSource` is exercised alongside the lints.
 *
 * - `scoped`     — sourced + sharded + `tenantBy` → safe.
 * - `unscoped`   — sourced + sharded, NO `tenantBy` → cross-tenant leak (ERROR).
 * - `rootSource` — sourced, NOT sharded → `tenantBy` optional, safe.
 * - `globalSrc`  — sourced + `.global()` → contradictory (ERROR).
 * - `plain`      — not sourced → never flagged.
 */
const schema = () =>
    fromServerSchema(
        defineSchema({
            globalSrc: defineTable({ value: v.string() }).global().source({ binding: "HD", query: "select id, value from g" }),
            plain: defineTable({ value: v.string() }),
            rootSource: defineTable({ value: v.string() }).source({ binding: "HD", query: "select id, value from r" }),
            scoped: defineTable({ orgId: v.string(), title: v.string() })
                .shardBy("orgId")
                .source({ binding: "HD", query: "select id, title, org_id from s where org_id = $1", tenantBy: (key) => [key] }),
            unscoped: defineTable({ orgId: v.string(), title: v.string() }).shardBy("orgId").source({ binding: "HD", query: "select id, title from u" }),
        }),
    );

describe("external_source_unscoped", () => {
    it("flags a sourced + sharded table with no tenantBy, and nothing else", () => {
        expect.assertions(3);

        const findings = externalSourceUnscoped.run({ schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "external_source_unscoped:unscoped",
            level: "ERROR",
            metadata: { table: "unscoped" },
            name: "external_source_unscoped",
        });
        expect(findings[0]?.detail).toContain("unscoped");
    });

    it("does not flag a sourced root (non-sharded) table — tenantBy is optional there", () => {
        expect.assertions(1);

        const findings = fromServerSchema(
            defineSchema({ rootSource: defineTable({ value: v.string() }).source({ binding: "HD", query: "select id, value from r" }) }),
        );

        expect(externalSourceUnscoped.run({ schema: findings })).toHaveLength(0);
    });

    it("does not flag a non-sourced schema", () => {
        expect.assertions(1);

        expect(
            externalSourceUnscoped.run({ schema: fromServerSchema(defineSchema({ plain: defineTable({ value: v.string() }).shardBy("value") })) }),
        ).toHaveLength(0);
    });
});

describe("external_source_on_global", () => {
    it("flags a table that is both .source() and .global()", () => {
        expect.assertions(2);

        const findings = externalSourceOnGlobal.run({ schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "external_source_on_global:globalSrc",
            level: "ERROR",
            metadata: { table: "globalSrc" },
            name: "external_source_on_global",
        });
    });

    it("does not flag a sourced sharded table", () => {
        expect.assertions(1);

        const findings = fromServerSchema(
            defineSchema({
                scoped: defineTable({ orgId: v.string() })
                    .shardBy("orgId")
                    .source({ binding: "HD", query: "select id, org_id from s where org_id = $1", tenantBy: (key) => [key] }),
            }),
        );

        expect(externalSourceOnGlobal.run({ schema: findings })).toHaveLength(0);
    });
});
