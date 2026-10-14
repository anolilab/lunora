import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import commitOrderedHardDelete from "../src/lints/static/commit-ordered-hard-delete";

const run = (schema: ReturnType<typeof defineSchema>) => commitOrderedHardDelete.run({ schema: fromServerSchema(schema) });

/**
 * The blind spot this lint names: `_commitSeq` lives on the row, so a hard
 * delete removes the row and its sequence together and the changefeed the
 * sequence exists to serve never learns the row is gone. `.softDelete()` closes
 * it — the tombstone flip is an UPDATE, so it advances the sequence.
 */
describe("commit_ordered_hard_delete", () => {
    it("flags a commit-ordered table with no tombstone", () => {
        expect.assertions(3);

        const schema = defineSchema({
            orders: defineTable({ status: v.string() }).commitOrdered(),
        });

        const findings = run(schema);

        expect(findings).toHaveLength(1);
        expect(findings[0]?.detail).toContain('"orders"');
        // A warning, not an error: append-only tables are a legitimate shape.
        expect(commitOrderedHardDelete.level).toBe("WARN");
    });

    it("passes when the table also soft-deletes", () => {
        expect.assertions(1);

        const schema = defineSchema({
            orders: defineTable({ status: v.string() }).commitOrdered().softDelete(),
        });

        expect(run(schema)).toHaveLength(0);
    });

    it("passes for a table that never opted into .commitOrdered()", () => {
        expect.assertions(1);

        const schema = defineSchema({
            orders: defineTable({ status: v.string() }),
        });

        expect(run(schema)).toHaveLength(0);
    });

    it("passes for a soft-deleting table that is not commit-ordered", () => {
        expect.assertions(1);

        // Nothing to warn about: with no `_commitSeq` there is no feed whose
        // completeness a hard delete could break.
        const schema = defineSchema({
            orders: defineTable({ status: v.string() }).softDelete(),
        });

        expect(run(schema)).toHaveLength(0);
    });

    it("honours a custom tombstone column", () => {
        expect.assertions(1);

        const schema = defineSchema({
            orders: defineTable({ status: v.string() }).commitOrdered().softDelete({ field: "removedAt" }),
        });

        expect(run(schema)).toHaveLength(0);
    });

    it("reports each offending table once", () => {
        expect.assertions(1);

        const schema = defineSchema({
            audit: defineTable({ event: v.string() }).commitOrdered(),
            fine: defineTable({ status: v.string() }).commitOrdered().softDelete(),
            orders: defineTable({ status: v.string() }).commitOrdered(),
        });

        expect(
            run(schema)
                .map((finding) => String(finding.metadata?.["table"]))
                .toSorted((a, b) => a.localeCompare(b)),
        ).toStrictEqual(["audit", "orders"]);
    });
});
