import { describe, expect, it } from "vitest";

/**
 * The schema must actually construct.
 *
 * `defineSchema` enforces rules at RUNTIME that codegen and `tsc` do not see —
 * most sharply, it refuses `v.bigint()` on a `.global()` table, because a global
 * table stores a bigint as decimal TEXT and SQL compares that lexicographically
 * ("100" before "25"), so `orderBy`, range filters and aggregates would silently
 * return wrong answers.
 *
 * `paymentSessions` had three such money columns. Every table in this schema is
 * `.global()`, so the throw was not scoped to billing: the schema never
 * constructed, and the Worker could not boot — every route 500ed. The entire
 * unit suite passed throughout, because nothing imported the schema module for
 * its side effect.
 */
describe("control-plane schema", () => {
    it("constructs — every `defineSchema` rule is satisfied", async () => {
        // The import IS the test: `defineSchema` runs its validations at module
        // evaluation, so a violation throws here rather than at first request.
        const module = await import("../lunora/schema");

        expect(module.default).toBeDefined();
    });

    it("declares no v.bigint() column, which `.global()` tables forbid", async () => {
        const { default: schema } = (await import("../lunora/schema")) as { default: { tables: Record<string, { shape: Record<string, { kind?: string }> }> } };

        const offenders = Object.entries(schema.tables).flatMap(([table, definition]) =>
            Object.entries(definition.shape ?? {})
                .filter(([, validator]) => validator?.kind === "bigint")
                .map(([column]) => `${table}.${column}`),
        );

        expect(offenders).toStrictEqual([]);
    });
});
