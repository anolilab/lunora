import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type { AdvisorMaskStrategy } from "../src";
import { fromServerSchema } from "../src";
import maskWeakHashStrategyOnPii from "../src/lints/static/mask-weak-hash-strategy-on-pii";

const schema = () =>
    fromServerSchema(
        defineSchema({
            users: defineTable({ count: v.number(), email: v.string(), ssn: v.string() }),
        }),
    );

const run = (maskStrategies?: AdvisorMaskStrategy[]) => maskWeakHashStrategyOnPii.run({ maskStrategies, schema: schema() });

/** Build a minimal AdvisorMaskStrategy. Defaults to a "hash" strategy on `users.email`. */
const strategy = (overrides: Partial<AdvisorMaskStrategy> = {}): AdvisorMaskStrategy => {
    return {
        column: "email",
        exportName: "listUsers",
        file: "listUsers",
        line: 5,
        strategy: "hash",
        table: "users",
        ...overrides,
    };
};

describe("mask_weak_hash_strategy_on_pii", () => {
    it("finds nothing when maskStrategies is undefined (runtime caller)", () => {
        expect.assertions(1);

        expect(run()).toHaveLength(0);
    });

    it("finds nothing when maskStrategies is an empty array", () => {
        expect.assertions(1);

        expect(run([])).toHaveLength(0);
    });

    it('flags a "hash" strategy on a PII-named column (email)', () => {
        expect.assertions(4);

        const findings = run([strategy({ column: "email", strategy: "hash" })]);

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "mask_weak_hash_strategy_on_pii:listUsers:5",
            categories: ["SECURITY"],
            level: "WARN",
            metadata: { column: "email", exportName: "listUsers", file: "listUsers", table: "users" },
            name: "mask_weak_hash_strategy_on_pii",
        });
        expect(findings[0]?.detail).toContain("email");
        expect(findings[0]?.detail).toContain('"hash"');
    });

    it('flags a "hash" strategy on another PII-named column (ssn)', () => {
        expect.assertions(2);

        const findings = run([strategy({ column: "ssn", line: 9, strategy: "hash" })]);

        expect(findings).toHaveLength(1);
        expect(findings[0]?.metadata["column"]).toBe("ssn");
    });

    it('does not flag a "hash" strategy on a non-PII column (count)', () => {
        expect.assertions(1);

        const findings = run([strategy({ column: "count", line: 12, strategy: "hash" })]);

        expect(findings).toHaveLength(0);
    });

    it('does not flag a "redact" strategy on a PII-named column', () => {
        expect.assertions(1);

        const findings = run([strategy({ column: "email", strategy: "redact" })]);

        expect(findings).toHaveLength(0);
    });

    it("emits one finding per offending row when several are supplied", () => {
        expect.assertions(1);

        const findings = run([
            strategy({ column: "email", line: 5, strategy: "hash" }),
            strategy({ column: "ssn", line: 6, strategy: "hash" }),
            strategy({ column: "count", line: 7, strategy: "hash" }),
            strategy({ column: "email", line: 8, strategy: "redact" }),
        ]);

        expect(findings).toHaveLength(2);
    });
});
