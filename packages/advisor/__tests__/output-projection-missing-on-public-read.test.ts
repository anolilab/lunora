import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import outputProjectionMissingOnPublicRead from "../src/lints/static/output-projection-missing-on-public-read";
import type { AdvisorRawRowReturn } from "../src/raw-row-returns";

const schema = () =>
    fromServerSchema(
        defineSchema({
            countries: defineTable({ code: v.string(), name: v.string() }),
            users: defineTable({ email: v.string(), name: v.string(), phone: v.string() }),
        }),
    );

const row = (overrides: Partial<AdvisorRawRowReturn>): AdvisorRawRowReturn => {
    return {
        exportName: "listUsers",
        file: "list",
        line: 1,
        table: "users",
        usesMask: false,
        usesOutput: false,
        visibility: "public",
        ...overrides,
    };
};

describe("output_projection_missing_on_public_read", () => {
    it("nudges a public raw-row query on a PII table with no projection", () => {
        expect.assertions(4);

        const findings = outputProjectionMissingOnPublicRead.run({ rawRowReturns: [row({})], schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            level: "INFO",
            metadata: { columns: ["email", "phone"], exportName: "listUsers", table: "users" },
            name: "output_projection_missing_on_public_read",
        });
        expect(findings[0]?.cacheKey).toBe("output_projection_missing_on_public_read:list:1");
        expect(findings[0]?.detail).toContain("email, phone");
    });

    it("stays quiet for an internal-visibility query", () => {
        expect.assertions(1);

        expect(outputProjectionMissingOnPublicRead.run({ rawRowReturns: [row({ visibility: "internal" })], schema: schema() })).toHaveLength(0);
    });

    it("stays quiet when the chain already carries an .output(...) projection", () => {
        expect.assertions(1);

        expect(outputProjectionMissingOnPublicRead.run({ rawRowReturns: [row({ usesOutput: true })], schema: schema() })).toHaveLength(0);
    });

    it("stays quiet when the chain carries a .use(mask(...)) policy", () => {
        expect.assertions(1);

        expect(outputProjectionMissingOnPublicRead.run({ rawRowReturns: [row({ usesMask: true })], schema: schema() })).toHaveLength(0);
    });

    it("stays quiet for a non-PII lookup table", () => {
        expect.assertions(1);

        expect(outputProjectionMissingOnPublicRead.run({ rawRowReturns: [row({ table: "countries" })], schema: schema() })).toHaveLength(0);
    });

    it("stays quiet when the table couldn't be resolved (empty table name)", () => {
        expect.assertions(1);

        expect(outputProjectionMissingOnPublicRead.run({ rawRowReturns: [row({ table: "" })], schema: schema() })).toHaveLength(0);
    });

    it("returns [] when rawRowReturns is undefined", () => {
        expect.assertions(1);

        expect(outputProjectionMissingOnPublicRead.run({ schema: schema() })).toHaveLength(0);
    });
});
