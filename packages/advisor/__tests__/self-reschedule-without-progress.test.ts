import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type { AdvisorCallEdge, AdvisorQueryRead, AdvisorRowEffect, AdvisorTableWrite, LintContext } from "../src";
import { fromServerSchema } from "../src";
import dispatchCycle from "../src/lints/static/dispatch-cycle";
import selfRescheduleWithoutProgress from "../src/lints/static/self-reschedule-without-progress";

const schema = fromServerSchema(defineSchema({ jobs: defineTable({ name: v.string() }) }));

/** A guarded `runAfter(delay, tick)` from inside `tick` of file `jobs/sweep`, with no args keys by default. */
const selfEdge = (overrides: Partial<AdvisorCallEdge> = {}): AdvisorCallEdge => {
    return {
        conditional: true,
        file: "jobs/sweep",
        kind: "schedule",
        line: 12,
        schedule: { argKeys: [], delayMs: 100 },
        scope: { kind: "export", name: "tick" },
        target: "jobs_sweep:tick",
        ...overrides,
    };
};

/** A read of `jobs` in `tick`, so the function has something it re-reads on every run. */
const selects: AdvisorQueryRead = { file: "jobs/sweep", hasFilter: false, hasIndex: false, line: 4, scope: { kind: "export", name: "tick" }, table: "jobs" };

const context = (overrides: Partial<LintContext> = {}): LintContext => {
    return { queries: [selects], schema, ...overrides };
};

describe("self_reschedule_without_progress", () => {
    it("finds nothing without call edges", () => {
        expect.assertions(1);

        expect(selfRescheduleWithoutProgress.run({ schema })).toHaveLength(0);
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

    it("says nothing at or above a minute, or without a literal delay", () => {
        expect.assertions(3);

        expect(selfRescheduleWithoutProgress.run(context({ callEdges: [selfEdge({ schedule: { argKeys: [], delayMs: 60_000 } })] }))).toHaveLength(0);
        expect(selfRescheduleWithoutProgress.run(context({ callEdges: [selfEdge({ schedule: { argKeys: [], delayMs: 3_600_000 } })] }))).toHaveLength(0);
        expect(selfRescheduleWithoutProgress.run(context({ callEdges: [selfEdge({ schedule: { argKeys: [] } })] }))).toHaveLength(0);
    });

    it("reports a poll between one second and a minute at INFO, where a spin is WARN", () => {
        expect.assertions(3);

        const findings = selfRescheduleWithoutProgress.run(context({ callEdges: [selfEdge({ schedule: { argKeys: [], delayMs: 5000 } })] }));

        expect(findings).toStrictEqual([expect.objectContaining({ level: "INFO", metadata: expect.objectContaining({ delayMs: 5000, tier: "poll" }) })]);
        expect(findings[0]?.detail).toContain("polls itself every 5000 ms");
        expect(selfRescheduleWithoutProgress.run(context({ callEdges: [selfEdge()] }))[0]).toMatchObject({ level: "WARN", metadata: { tier: "spin" } });
    });

    it("counts a rewrite of a read row as progress for a spin, but not for a poll", () => {
        expect.assertions(4);

        const rewrites: AdvisorTableWrite = { file: "jobs/sweep", line: 14, method: "patch", scope: { kind: "export", name: "tick" }, table: "jobs" };
        const removes: AdvisorTableWrite = { file: "jobs/sweep", line: 14, method: "delete", scope: { kind: "export", name: "tick" }, table: "jobs" };
        const poll = selfEdge({ schedule: { argKeys: [], delayMs: 5000 } });

        // A spin keeps the old rule: a patch is progress, so it stays quiet.
        expect(selfRescheduleWithoutProgress.run(context({ callEdges: [selfEdge()], tableWrites: [rewrites] }))).toHaveLength(0);
        // A poll rewrites every tick, which is the cost, so the same patch does not clear it.
        expect(selfRescheduleWithoutProgress.run(context({ callEdges: [poll], tableWrites: [rewrites] }))).toHaveLength(1);
        // A removal clears a poll, as it does a spin.
        expect(selfRescheduleWithoutProgress.run(context({ callEdges: [poll], tableWrites: [removes] }))).toHaveLength(0);
        expect(selfRescheduleWithoutProgress.run(context({ callEdges: [poll], tableWrites: [rewrites, removes] }))).toHaveLength(0);
    });

    it("says nothing when the args carry a cursor key, under any of the usual names", () => {
        expect.assertions(3);

        expect(selfRescheduleWithoutProgress.run(context({ callEdges: [selfEdge({ schedule: { argKeys: ["cursor"], delayMs: 100 } })] }))).toHaveLength(0);
        expect(selfRescheduleWithoutProgress.run(context({ callEdges: [selfEdge({ schedule: { argKeys: ["continueCursor"], delayMs: 100 } })] }))).toHaveLength(
            0,
        );
        expect(selfRescheduleWithoutProgress.run(context({ callEdges: [selfEdge({ schedule: { argKeys: ["next_cursor"], delayMs: 100 } })] }))).toHaveLength(0);
    });

    it("still flags a key that only mentions a cursor, such as a reset flag or a mouse cursor", () => {
        expect.assertions(2);

        expect(selfRescheduleWithoutProgress.run(context({ callEdges: [selfEdge({ schedule: { argKeys: ["resetCursor"], delayMs: 100 } })] }))).toHaveLength(1);
        expect(selfRescheduleWithoutProgress.run(context({ callEdges: [selfEdge({ schedule: { argKeys: ["cursorX"], delayMs: 100 } })] }))).toHaveLength(1);
    });

    it("says nothing when the args cannot be read, since there is no evidence either way", () => {
        expect.assertions(1);

        expect(selfRescheduleWithoutProgress.run(context({ callEdges: [selfEdge({ schedule: { delayMs: 100 } })] }))).toHaveLength(0);
    });

    it("says nothing when the function removes a row it reads", () => {
        expect.assertions(1);

        const deletes: AdvisorTableWrite = { file: "jobs/sweep", line: 14, method: "delete", scope: { kind: "export", name: "tick" }, table: "jobs" };

        expect(selfRescheduleWithoutProgress.run(context({ callEdges: [selfEdge()], tableWrites: [deletes] }))).toHaveLength(0);
    });

    it("says nothing when the function has no reads, since there is nothing to re-read", () => {
        expect.assertions(1);

        expect(selfRescheduleWithoutProgress.run(context({ callEdges: [selfEdge()], queries: [] }))).toHaveLength(0);
    });

    it("says nothing when the function calls out to another function, which may make the progress", () => {
        expect.assertions(1);

        // The batch-drain shape: the action calls a mutation that deletes, then re-arms itself.
        const callsOut: AdvisorCallEdge = { file: "jobs/sweep", kind: "call", line: 10, scope: { kind: "export", name: "tick" }, target: "jobs_batch:drop" };

        expect(selfRescheduleWithoutProgress.run(context({ callEdges: [selfEdge(), callsOut] }))).toHaveLength(0);
    });

    it("leaves an unconditional self-dispatch to dispatch_cycle, and a guarded one to this rule", () => {
        expect.assertions(4);

        const unconditional = selfEdge({ conditional: undefined });
        const guarded = selfEdge();

        expect(selfRescheduleWithoutProgress.run(context({ callEdges: [unconditional] }))).toHaveLength(0);
        expect(dispatchCycle.run({ callEdges: [unconditional], schema })).toHaveLength(1);
        expect(dispatchCycle.run({ callEdges: [guarded], schema })).toHaveLength(0);
        expect(selfRescheduleWithoutProgress.run(context({ callEdges: [guarded] }))).toHaveLength(1);
    });

    it("says nothing about a dispatch to another function", () => {
        expect.assertions(1);

        expect(selfRescheduleWithoutProgress.run(context({ callEdges: [selfEdge({ target: "jobs_other:tick" })] }))).toHaveLength(0);
    });

    it("says nothing when a helper in another file deletes the rows the function reads", () => {
        expect.assertions(1);

        const effect: AdvisorRowEffect = { exportName: "tick", file: "jobs/sweep", method: "delete", table: "jobs" };

        expect(selfRescheduleWithoutProgress.run(context({ callEdges: [selfEdge()], rowEffects: [effect] }))).toHaveLength(0);
    });

    it("judges the rescheduling function's own progress when a shared helper read also serves another function that deletes", () => {
        expect.assertions(1);

        // `tick` reschedules over a helper read that `other` also reaches, and `other` deletes. `tick` removes nothing.
        const shared: AdvisorQueryRead = {
            file: "jobs/sweep",
            hasFilter: false,
            hasIndex: false,
            line: 4,
            scope: { callers: ["tick", "other"], kind: "helper", name: "scan" },
            table: "jobs",
        };
        const deletesInOther: AdvisorTableWrite = { file: "jobs/sweep", line: 14, method: "delete", scope: { kind: "export", name: "other" }, table: "jobs" };

        expect(selfRescheduleWithoutProgress.run(context({ callEdges: [selfEdge()], queries: [shared], tableWrites: [deletesInOther] }))).toHaveLength(1);
    });
});
