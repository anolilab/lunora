import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import normalizeIdUsedAsAuthorization from "../src/lints/static/normalize-id-used-as-authorization";
import type { AdvisorNormalizeIdAuthorization } from "../src/normalize-id-authorization";

const openSchema = () => fromServerSchema(defineSchema({ posts: defineTable({ author: v.string(), title: v.string() }) }));

const rlsRequiredSchema = () =>
    fromServerSchema(
        defineSchema({
            emojis: defineTable({ char: v.string() }).public(),
            posts: defineTable({ author: v.string(), title: v.string() }),
        }).rls("required"),
    );

const row = (overrides: Partial<AdvisorNormalizeIdAuthorization>): AdvisorNormalizeIdAuthorization => {
    return {
        exportName: "getPost",
        file: "read",
        line: 3,
        mentionsOwnership: false,
        sinkMethod: "get",
        table: "posts",
        usesRls: false,
        visibility: "public",
        ...overrides,
    };
};

describe("normalize_id_used_as_authorization", () => {
    it("flags a public procedure gating access on normalizeId with no ownership check or RLS", () => {
        expect.assertions(4);

        const findings = normalizeIdUsedAsAuthorization.run({ normalizeIdAuthorizations: [row({})], schema: openSchema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            level: "INFO",
            metadata: { exportName: "getPost", sinkMethod: "get", table: "posts" },
            name: "normalize_id_used_as_authorization",
        });
        expect(findings[0]?.cacheKey).toBe("normalize_id_used_as_authorization:read:3");
        expect(findings[0]?.detail).toContain("normalizeId");
    });

    it("stays quiet for an internal-visibility procedure", () => {
        expect.assertions(1);

        expect(normalizeIdUsedAsAuthorization.run({ normalizeIdAuthorizations: [row({ visibility: "internal" })], schema: openSchema() })).toHaveLength(0);
    });

    it("stays quiet when the procedure carries a .use(rls(...)) step", () => {
        expect.assertions(1);

        expect(normalizeIdUsedAsAuthorization.run({ normalizeIdAuthorizations: [row({ usesRls: true })], schema: openSchema() })).toHaveLength(0);
    });

    it("stays quiet when the handler mentions ownership/identity", () => {
        expect.assertions(1);

        expect(normalizeIdUsedAsAuthorization.run({ normalizeIdAuthorizations: [row({ mentionsOwnership: true })], schema: openSchema() })).toHaveLength(0);
    });

    it("stays quiet when the schema requires RLS and the table did not opt out", () => {
        expect.assertions(1);

        expect(normalizeIdUsedAsAuthorization.run({ normalizeIdAuthorizations: [row({ table: "posts" })], schema: rlsRequiredSchema() })).toHaveLength(0);
    });

    it("still flags an rls-required schema when the target table opted out via .public()", () => {
        expect.assertions(1);

        expect(normalizeIdUsedAsAuthorization.run({ normalizeIdAuthorizations: [row({ table: "emojis" })], schema: rlsRequiredSchema() })).toHaveLength(1);
    });

    it("stays quiet under required RLS when the table couldn't be resolved (empty table)", () => {
        expect.assertions(1);

        expect(normalizeIdUsedAsAuthorization.run({ normalizeIdAuthorizations: [row({ table: "" })], schema: rlsRequiredSchema() })).toHaveLength(0);
    });

    it("flags an unresolved table when the schema does not require RLS", () => {
        expect.assertions(2);

        const findings = normalizeIdUsedAsAuthorization.run({ normalizeIdAuthorizations: [row({ table: "" })], schema: openSchema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]?.detail).toContain("the row");
    });

    it("returns [] when normalizeIdAuthorizations is undefined", () => {
        expect.assertions(1);

        expect(normalizeIdUsedAsAuthorization.run({ schema: openSchema() })).toHaveLength(0);
    });
});
