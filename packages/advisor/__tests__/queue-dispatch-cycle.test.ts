import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type { AdvisorCallEdge, AdvisorQueue, LintContext } from "../src";
import { fromServerSchema } from "../src";
import queueDispatchCycle from "../src/lints/static/queue-dispatch-cycle";

const schema = fromServerSchema(defineSchema({ jobs: defineTable({ name: v.string() }) }));

/** A push consumer declared in `queues.ts`, for the export `exportName`. */
const consumer = (exportName: string, overrides: Partial<AdvisorQueue> = {}): AdvisorQueue => {
    return { exportName, filePath: "queues", mode: "push", name: exportName, tuning: {}, ...overrides };
};

/** A call edge from export `from` in `file` (default: the queue consumer's file). */
const edge = (file: string, from: string, kind: AdvisorCallEdge["kind"], target: string, overrides: Partial<AdvisorCallEdge> = {}): AdvisorCallEdge => {
    return { file, kind, line: 10, scope: { kind: "export", name: from }, target, ...overrides };
};

const context = (callEdges: AdvisorCallEdge[] | undefined, queues: AdvisorQueue[] | undefined): LintContext => {
    return { callEdges, queues, schema };
};

/** A batch consumer whose loop reaches `mail:requeue`, which sends back to its own queue. */
const batchLoopRequeue = (overrides: Partial<AdvisorCallEdge> = {}): AdvisorCallEdge[] => [
    edge("queues", "emailQueue", "call", "mail:requeue", { loopOnly: true, conditional: true, ...overrides }),
    edge("mail", "requeue", "enqueue", "emailQueue"),
];

describe("queue_dispatch_cycle", () => {
    it("finds nothing without call edges or without queues (runtime caller)", () => {
        expect.assertions(2);

        expect(queueDispatchCycle.run(context(undefined, [consumer("emailQueue")]))).toHaveLength(0);
        expect(queueDispatchCycle.run(context(batchLoopRequeue(), undefined))).toHaveLength(0);
    });

    it("flags a batch consumer whose loop reaches a function that re-enqueues to the same queue", () => {
        expect.assertions(3);

        const findings = queueDispatchCycle.run(context(batchLoopRequeue(), [consumer("emailQueue")]));

        expect(findings).toStrictEqual([
            expect.objectContaining({
                cacheKey: "queue_dispatch_cycle:mail:requeue,queue:emailQueue",
                level: "ERROR",
                name: "queue_dispatch_cycle",
            }),
        ]);
        expect(findings[0]?.detail).toContain("`queue:emailQueue` calls `mail:requeue` (queues:10)");
        expect(findings[0]?.detail).toContain("`mail:requeue` enqueues to `queue:emailQueue` (mail:10)");
    });

    it("clears a re-enqueue behind a guard that is not a loop", () => {
        expect.assertions(1);

        const guarded = batchLoopRequeue({ loopOnly: undefined });

        expect(queueDispatchCycle.run(context(guarded, [consumer("emailQueue")]))).toHaveLength(0);
    });

    it("reads a handler passed by reference as the queue's consumer", () => {
        expect.assertions(1);

        // `handler: process` is exported from another file, so the call site is attributed to `mail_consumer:process`.
        const queue = consumer("emailQueue", { handlerSite: { exportName: "process", file: "mail/consumer" } });
        const edges = [
            edge("mail/consumer", "process", "call", "mail:requeue", { loopOnly: true, conditional: true }),
            edge("mail", "requeue", "enqueue", "emailQueue"),
        ];

        expect(queueDispatchCycle.run(context(edges, [queue]))).toHaveLength(1);
    });

    it("flags a topic cycle: a subscriber's loop reaches a publish that the same subscriber receives", () => {
        expect.assertions(2);

        const audit = consumer("audit", { topic: "events" });
        const edges = [edge("queues", "audit", "call", "orders:place", { loopOnly: true, conditional: true }), edge("orders", "place", "publish", "events")];
        const findings = queueDispatchCycle.run(context(edges, [audit]));

        expect(findings.map((finding) => finding.cacheKey)).toStrictEqual(["queue_dispatch_cycle:orders:place,queue:audit,topic:events"]);
        expect(findings[0]?.detail).toContain("`orders:place` publishes to `topic:events`");
    });

    it("says nothing about a chain that ends, or a cycle that never passes through a queue", () => {
        expect.assertions(2);

        const chain = [
            edge("queues", "emailQueue", "call", "mail:requeue", { loopOnly: true, conditional: true }),
            edge("mail", "requeue", "enqueue", "other"),
        ];

        expect(queueDispatchCycle.run(context(chain, [consumer("emailQueue"), consumer("other")]))).toHaveLength(0);
        expect(queueDispatchCycle.run(context([edge("jobs", "tick", "schedule", "jobs:tick")], [consumer("emailQueue")]))).toHaveLength(0);
    });

    it("ignores an enqueue to a queue the feeder does not declare", () => {
        expect.assertions(1);

        const edges = [
            edge("queues", "emailQueue", "call", "mail:requeue", { loopOnly: true, conditional: true }),
            edge("mail", "requeue", "enqueue", "ghost"),
        ];

        expect(queueDispatchCycle.run(context(edges, [consumer("emailQueue")]))).toHaveLength(0);
    });
});
