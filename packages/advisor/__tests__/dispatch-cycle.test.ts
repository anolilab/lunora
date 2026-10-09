import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type { AdvisorCallEdge, LintContext } from "../src";
import { fromServerSchema, STATIC_LINTS } from "../src";
import dispatchCycle from "../src/lints/static/dispatch-cycle";

const context = (callEdges?: AdvisorCallEdge[]): LintContext => {
    return { callEdges, schema: fromServerSchema(defineSchema({ jobs: defineTable({ name: v.string() }) })) };
};

/** An unconditional edge from export `from` in `file` to the function key `target`. */
const edge = (file: string, from: string, target: string, overrides: Partial<AdvisorCallEdge> = {}): AdvisorCallEdge => {
    return { file, kind: "schedule", line: 10, scope: { kind: "export", name: from }, target, ...overrides };
};

describe("dispatch_cycle", () => {
    it("is registered as a static lint", () => {
        expect.assertions(1);

        expect(STATIC_LINTS).toContain(dispatchCycle);
    });

    it("finds nothing without call edges", () => {
        expect.assertions(1);

        expect(dispatchCycle.run(context())).toHaveLength(0);
    });

    it("flags a function that always reschedules itself", () => {
        expect.assertions(1);

        expect(dispatchCycle.run(context([edge("jobs/sweep", "tick", "jobs_sweep:tick")]))).toStrictEqual([
            expect.objectContaining({
                cacheKey: "dispatch_cycle:jobs_sweep:tick",
                detail: expect.stringContaining("`jobs_sweep:tick` schedules `jobs_sweep:tick` (jobs/sweep:10)"),
                level: "ERROR",
                metadata: {
                    functions: ["jobs_sweep:tick"],
                    hops: [{ file: "jobs/sweep", from: "jobs_sweep:tick", kind: "schedule", line: 10, to: "jobs_sweep:tick" }],
                },
                name: "dispatch_cycle",
            }),
        ]);
    });

    it("flags a two-function ping-pong once, across files and edge kinds", () => {
        expect.assertions(2);

        const findings = dispatchCycle.run(
            context([edge("a", "ping", "b:pong"), edge("b", "pong", "a:ping", { kind: "call", line: 4 }), edge("a", "ping", "mail:send")]),
        );

        expect(findings.map((finding) => finding.cacheKey)).toStrictEqual(["dispatch_cycle:a:ping,b:pong"]);
        expect(findings[0]?.metadata).toMatchObject({ functions: ["a:ping", "b:pong"] });
    });

    it("collapses a feature folder's index into its namespace", () => {
        expect.assertions(1);

        expect(dispatchCycle.run(context([edge("billing/index", "retry", "billing:retry")]))).toHaveLength(1);
    });

    it("clears a cycle when any hop sits behind a guard", () => {
        expect.assertions(2);

        expect(dispatchCycle.run(context([edge("jobs", "tick", "jobs:tick", { conditional: true })]))).toHaveLength(0);
        expect(dispatchCycle.run(context([edge("a", "ping", "b:pong"), edge("b", "pong", "a:ping", { conditional: true })]))).toHaveLength(0);
    });

    it("ignores a hop made from a helper, whose own call may be guarded", () => {
        expect.assertions(1);

        expect(dispatchCycle.run(context([edge("jobs", "tick", "jobs:tick", { scope: { callers: ["tick"], kind: "helper", name: "rearm" } })]))).toHaveLength(
            0,
        );
    });

    it("ignores enqueues, publishes, and unreadable targets", () => {
        expect.assertions(1);

        expect(
            dispatchCycle.run(
                context([
                    edge("jobs", "tick", "jobs:tick", { kind: "enqueue" }),
                    edge("jobs", "tick", "jobs:tick", { kind: "publish" }),
                    { file: "jobs", kind: "schedule", line: 3, reason: "not static", scope: { kind: "export", name: "tick" } },
                ]),
            ),
        ).toHaveLength(0);
    });

    it("does not flag a chain that ends", () => {
        expect.assertions(1);

        expect(dispatchCycle.run(context([edge("a", "one", "a:two"), edge("a", "two", "a:three")]))).toHaveLength(0);
    });
});
