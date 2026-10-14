import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type { AdvisorFlagRead } from "../src";
import { ALL_LINTS, flagReadInSubscription, fromServerSchema, runAdvisor } from "../src";

const schema = () =>
    fromServerSchema(
        defineSchema({
            messages: defineTable({ body: v.string() }),
        }),
    );

const run = (flagReads?: AdvisorFlagRead[]) => flagReadInSubscription.run({ flagReads, schema: schema() });

describe("flag_read_in_subscription", () => {
    it("finds nothing when no read evidence is supplied (runtime caller)", () => {
        expect.assertions(1);

        // A runtime caller (no codegen feeder) must not flag anything.
        expect(run()).toHaveLength(0);
    });

    it("flags ctx.flags.boolean() inside a query handler", () => {
        expect.assertions(2);

        const reads: AdvisorFlagRead[] = [{ callee: "ctx.flags.boolean", exportName: "listMessages", file: "messages", line: 9 }];
        const findings = run(reads);

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "flag_read_in_subscription:messages:9:ctx.flags.boolean",
            categories: ["SCHEMA"],
            level: "WARN",
            metadata: { callee: "ctx.flags.boolean", exportName: "listMessages", file: "messages", line: 9 },
            name: "flag_read_in_subscription",
        });
    });

    it("flags a ctx.flags.details.* read the same way", () => {
        expect.assertions(1);

        expect(run([{ callee: "ctx.flags.details.string", exportName: "listMessages", file: "messages", line: 12 }])).toHaveLength(1);
    });

    it("is clean for a mutation and for useFlag (the feeder records neither)", () => {
        expect.assertions(1);

        // The feeder records reads only inside `query` handlers, so a flag read in a
        // mutation never reaches the lint — and `useFlag` is a client subscription
        // served on the reactive flag path, which has no `lunora/` handler at all.
        // Both are modelled here by empty evidence, the shape the feeder produces.
        expect(run([])).toHaveLength(0);
    });

    it("keeps two same-line reads of the same surface as separate dismissible findings", () => {
        expect.assertions(2);

        // `Promise.all([ctx.flags.boolean("a", …), ctx.flags.boolean("b", …)])` puts
        // two reads on one line with an identical (file, line, callee) key; without
        // the occurrence suffix they would collapse into one finding.
        const sameLine: AdvisorFlagRead[] = [
            { callee: "ctx.flags.boolean", exportName: "listMessages", file: "messages", line: 9 },
            { callee: "ctx.flags.boolean", exportName: "listMessages", file: "messages", line: 9 },
        ];
        const findings = run(sameLine);

        expect(findings).toHaveLength(2);
        expect(new Set(findings.map((finding) => finding.cacheKey)).size).toBe(2);
    });

    it("runs through the default static set (an unregistered lint never fires in production)", () => {
        expect.assertions(2);

        expect(ALL_LINTS).toContain(flagReadInSubscription);

        const findings = runAdvisor(
            { flagReads: [{ callee: "ctx.flags.boolean", exportName: "listMessages", file: "messages", line: 9 }], schema: schema() },
            { source: "static" },
        );

        expect(findings.some((finding) => finding.name === "flag_read_in_subscription" && finding.level === "WARN")).toBe(true);
    });
});
