import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type { AdvisorCallEdge, AdvisorQueryRead, AdvisorTableWrite, LintContext } from "../src";
import { fromServerSchema } from "../src";
import dispatchCycle from "../src/lints/static/dispatch-cycle";
import selfRescheduleWithoutProgress from "../src/lints/static/self-reschedule-without-progress";

const schema = fromServerSchema(defineSchema({ jobs: defineTable({ name: v.string() }) }));

/** A guarded `runAfter(delay, tick)` from inside `tick` of file `jobs/sweep`. */
const selfEdge = (overrides: Partial<AdvisorCallEdge> = {}): AdvisorCallEdge => {
    return {
        conditional: true,
        delayMs: 100,
        file: "jobs/sweep",
        kind: "schedule",
        line: 12,
        scope: { kind: "export", name: "tick" },
        target: "jobs_sweep:tick",
        ...overrides,
    };
};

const context = (overrides: Partial<LintContext> = {}): LintContext => {
    return { schema, ...overrides };
};

describe("self_reschedule_without_progress", () => {
    it("finds nothing without call edges", () => {
        expect.assertions(1);

        expect(selfRescheduleWithoutProgress.run(context())).toHaveLength(0);
    });

    it("flags a guarded self-reschedule on a short delay with no cursor", () => {
        expect.assertions(2);

        const findings = selfRescheduleWithoutProgress.run(context({ callEdges: [selfEdge()] }));

        expect(findings).toStrictEqual([
            expect.objectContaining({
                cacheKey: "self_reschedule_without_progress:jobs/sweep:12:tick",
                level: "WARN",
                name: "self_reschedule_without_progress",
            }),
        ]);
        expect(findings[0]?.detail).toContain("100 ms");
    });

    it("says nothing at or above one second, or for a runAt dispatch with no delay", () => {
        expect.assertions(2);

        expect(selfRescheduleWithoutProgress.run(context({ callEdges: [selfEdge({ delayMs: 1000 })] }))).toHaveLength(0);
        expect(selfRescheduleWithoutProgress.run(context({ callEdges: [selfEdge({ delayMs: undefined })] }))).toHaveLength(0);
    });

    it("says nothing when the re-arming passes a cursor", () => {
        expect.assertions(1);

        expect(selfRescheduleWithoutProgress.run(context({ callEdges: [selfEdge({ passesCursor: true })] }))).toHaveLength(0);
    });

    it("says nothing when the function removes a row it selects", () => {
        expect.assertions(1);

        const selects: AdvisorQueryRead = {
            file: "jobs/sweep",
            hasFilter: false,
            hasIndex: false,
            line: 4,
            scope: { kind: "export", name: "tick" },
            table: "jobs",
        };
        const deletes: AdvisorTableWrite = {
            file: "jobs/sweep",
            line: 14,
            method: "delete",
            scope: { kind: "export", name: "tick" },
            table: "jobs",
        };

        expect(selfRescheduleWithoutProgress.run(context({ callEdges: [selfEdge()], queries: [selects], tableWrites: [deletes] }))).toHaveLength(0);
    });

    it("leaves an unconditional self-dispatch to dispatch_cycle, and a guarded one to this rule", () => {
        expect.assertions(4);

        const unconditional = selfEdge({ conditional: undefined });
        const guarded = selfEdge();

        expect(selfRescheduleWithoutProgress.run(context({ callEdges: [unconditional] }))).toHaveLength(0);
        expect(dispatchCycle.run(context({ callEdges: [unconditional] }))).toHaveLength(1);
        expect(dispatchCycle.run(context({ callEdges: [guarded] }))).toHaveLength(0);
        expect(selfRescheduleWithoutProgress.run(context({ callEdges: [guarded] }))).toHaveLength(1);
    });

    it("says nothing about a dispatch to another function", () => {
        expect.assertions(1);

        expect(selfRescheduleWithoutProgress.run(context({ callEdges: [selfEdge({ target: "jobs_other:tick" })] }))).toHaveLength(0);
    });
});
