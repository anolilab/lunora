import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import publicTableRlsOptoutConfusion from "../src/lints/static/public-table-rls-optout-confusion";

describe("public_table_rls_optout_confusion", () => {
    it("flags a .public() table with ownership-shaped columns under .rls(\"required\")", () => {
        expect.assertions(2);

        const schema = fromServerSchema(
            defineSchema({
                accounts: defineTable({ email: v.string(), userId: v.string() }).public(),
            }).rls("required"),
        );
        const findings = publicTableRlsOptoutConfusion.run({ schema });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "public_table_rls_optout_confusion:accounts",
            categories: ["SECURITY"],
            level: "WARN",
            metadata: { columns: ["email", "userId"], table: "accounts" },
            name: "public_table_rls_optout_confusion",
        });
    });

    it("does not flag a .public() table with no ownership/PII-shaped columns (a genuine lookup table)", () => {
        expect.assertions(1);

        const schema = fromServerSchema(
            defineSchema({
                emojis: defineTable({ glyph: v.string(), shortcode: v.string() }).public(),
            }).rls("required"),
        );

        expect(publicTableRlsOptoutConfusion.run({ schema })).toHaveLength(0);
    });

    it('does not flag a .public() table when the schema never called .rls("required") (documented no-op)', () => {
        expect.assertions(1);

        const schema = fromServerSchema(
            defineSchema({
                accounts: defineTable({ email: v.string(), userId: v.string() }).public(),
            }),
        );

        expect(publicTableRlsOptoutConfusion.run({ schema })).toHaveLength(0);
    });

    it("does not flag a non-.public() table regardless of its columns", () => {
        expect.assertions(1);

        const schema = fromServerSchema(
            defineSchema({
                accounts: defineTable({ email: v.string(), userId: v.string() }),
            }).rls("required"),
        );

        expect(publicTableRlsOptoutConfusion.run({ schema })).toHaveLength(0);
    });

    it("flags every .public() table with sensitive columns, one finding each", () => {
        expect.assertions(1);

        const schema = fromServerSchema(
            defineSchema({
                accounts: defineTable({ email: v.string() }).public(),
                profiles: defineTable({ phone: v.string() }).public(),
            }).rls("required"),
        );

        expect(publicTableRlsOptoutConfusion.run({ schema })).toHaveLength(2);
    });
});
