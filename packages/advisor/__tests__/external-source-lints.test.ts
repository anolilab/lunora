import { describe, expect, it } from "vitest";

import type { AdvisorSchema, AdvisorTable } from "../src";
import externalSourceOnGlobal from "../src/lints/static/external-source-on-global";
import externalSourceUnscoped from "../src/lints/static/external-source-unscoped";

/**
 * Tenant-scope + tier-contradiction lints for `.source(...)` (plan 077). The lints
 * read the discovered `AdvisorSchema` (codegen feeder), so they are tested against
 * `AdvisorTable` literals directly — `defineSchema` now *throws* on the unscoped /
 * global cases at runtime (the hard fail-safe), so it can't construct the very
 * inputs these build-time lints must flag from static analysis.
 */

const table = (overrides: Partial<AdvisorTable> & { name: string }): AdvisorTable => {
    return {
        fields: [],
        indexes: [],
        relations: [],
        ...overrides,
    };
};

const schema = (tables: AdvisorTable[]): AdvisorSchema => {
    return { tables };
};

describe("external_source_unscoped", () => {
    it("flags a sourced + sharded table with no tenantBy, and nothing else", () => {
        expect.assertions(3);

        const findings = externalSourceUnscoped.run({
            schema: schema([
                table({ externalSource: { hasTenantBy: false }, name: "unscoped", shardKind: "shardBy" }),
                table({ externalSource: { hasTenantBy: true }, name: "scoped", shardKind: "shardBy" }),
                table({ externalSource: { hasTenantBy: false }, name: "rootSource", shardKind: "root" }),
                table({ name: "plain", shardKind: "shardBy" }),
            ]),
        });

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

        expect(
            externalSourceUnscoped.run({ schema: schema([table({ externalSource: { hasTenantBy: false }, name: "rootSource", shardKind: "root" })]) }),
        ).toHaveLength(0);
    });

    it("does not flag a non-sourced schema", () => {
        expect.assertions(1);

        expect(externalSourceUnscoped.run({ schema: schema([table({ name: "plain", shardKind: "shardBy" })]) })).toHaveLength(0);
    });
});

describe("external_source_on_global", () => {
    it("flags a table that is both .source() and .global()", () => {
        expect.assertions(2);

        const findings = externalSourceOnGlobal.run({
            schema: schema([
                table({ externalSource: { hasTenantBy: false }, name: "globalSrc", shardKind: "global" }),
                table({ externalSource: { hasTenantBy: true }, name: "scoped", shardKind: "shardBy" }),
            ]),
        });

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

        expect(
            externalSourceOnGlobal.run({ schema: schema([table({ externalSource: { hasTenantBy: true }, name: "scoped", shardKind: "shardBy" })]) }),
        ).toHaveLength(0);
    });
});
