import { describe, expect, it } from "vitest";

import type { AdvisorSchema, AdvisorTable } from "../src";
import externalSourceIncrementalNoDeletePath from "../src/lints/static/external-source-incremental-no-delete-path";
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

    it("wARNs (not ERRORs) on a sourced + sharded table whose config is not statically analyzable", () => {
        expect.assertions(3);

        const findings = externalSourceUnscoped.run({
            schema: schema([table({ externalSource: { hasTenantBy: false, unanalyzable: true }, name: "dynamic", shardKind: "shardBy" })]),
        });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "external_source_unscoped:dynamic",
            level: "WARN",
            metadata: { table: "dynamic" },
            name: "external_source_unscoped",
        });
        expect(findings[0]?.detail).toContain("not a static object literal");
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

describe("external_source_incremental_no_delete_path", () => {
    it("flags an incremental source with neither reconcile nor soft-delete", () => {
        expect.assertions(2);

        const findings = externalSourceIncrementalNoDeletePath.run({
            schema: schema([table({ externalSource: { hasTenantBy: true, mode: "incremental" }, name: "leaky", shardKind: "shardBy" })]),
        });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "external_source_incremental_no_delete_path:leaky",
            level: "ERROR",
            metadata: { table: "leaky" },
            name: "external_source_incremental_no_delete_path",
        });
    });

    it("does not flag an incremental source with a reconcile sweep or a soft-delete column", () => {
        expect.assertions(1);

        expect(
            externalSourceIncrementalNoDeletePath.run({
                schema: schema([
                    table({ externalSource: { hasReconcile: true, hasTenantBy: true, mode: "incremental" }, name: "reconciled", shardKind: "shardBy" }),
                    table({ externalSource: { hasSoftDelete: true, hasTenantBy: true, mode: "incremental" }, name: "tombstoned", shardKind: "shardBy" }),
                ]),
            }),
        ).toHaveLength(0);
    });

    it("does not flag a full-pull source (it observes deletes natively)", () => {
        expect.assertions(1);

        expect(
            externalSourceIncrementalNoDeletePath.run({
                schema: schema([table({ externalSource: { hasTenantBy: true, mode: "full-pull" }, name: "fullpull", shardKind: "shardBy" })]),
            }),
        ).toHaveLength(0);
    });

    it("wARNs on an unanalyzable incremental config", () => {
        expect.assertions(2);

        const findings = externalSourceIncrementalNoDeletePath.run({
            schema: schema([table({ externalSource: { hasTenantBy: true, unanalyzable: true }, name: "dynamic", shardKind: "shardBy" })]),
        });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ level: "WARN", name: "external_source_incremental_no_delete_path" });
    });
});
