import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCodegen } from "../src/index";

/**
 * `queue_dispatch_cycle` through real codegen: each case is a `lunora/` project
 * whose call edges come from the discovery pass, not a hand-built edge list, so a
 * feeder that drops `conditional`/`loopOnly` shows up as a missing or extra finding.
 */

let workdir: string;

const writeLunora = (name: string, source: string): void => {
    writeFileSync(join(workdir, "lunora", name), source, "utf8");
};

/** The `queue_dispatch_cycle` findings the real codegen run reports for the project. */
const cycleFindings = () =>
    runCodegen({ projectRoot: workdir, wranglerQueueProducers: [] }).advisories.filter((advisory) => advisory.name === "queue_dispatch_cycle");

describe("queue_dispatch_cycle through codegen discovery", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-queue-cycle-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        writeLunora(
            "schema.ts",
            `import { defineSchema, defineTable, v } from "@lunora/server";\n\nexport default defineSchema({ jobs: defineTable({ name: v.string() }) });\n`,
        );
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("does not flag a batch consumer whose re-enqueue is guarded by a cursor check", () => {
        expect.assertions(1);

        writeLunora(
            "queues.ts",
            `import { defineQueue } from "@lunora/queue";

export const emailQueue = defineQueue({
    handler: async (batch, ctx) => {
        for (const message of batch.messages) {
            const page = await loadPage(message.body.cursor);
            if (page.continueCursor) await ctx.queues.emailQueue.send({ cursor: page.continueCursor });
        }
    },
});
`,
        );

        expect(cycleFindings()).toHaveLength(0);
    });

    it("flags an unconditional re-enqueue inside the batch loop", () => {
        expect.assertions(2);

        writeLunora(
            "queues.ts",
            `import { defineQueue } from "@lunora/queue";

export const emailQueue = defineQueue({
    handler: async (batch, ctx) => {
        for (const message of batch.messages) {
            await ctx.queues.emailQueue.send(message.body);
        }
    },
});
`,
        );

        const findings = cycleFindings();

        expect(findings.map((finding) => finding.cacheKey)).toStrictEqual(["queue_dispatch_cycle:queue:emailQueue"]);
        expect(findings[0]?.detail).toContain("`queue:emailQueue` enqueues to `queue:emailQueue`");
    });

    it("does not flag a re-enqueue on the failure path of a try/catch", () => {
        expect.assertions(1);

        writeLunora(
            "queues.ts",
            `import { defineQueue } from "@lunora/queue";

export const emailQueue = defineQueue({
    handler: async (batch, ctx) => {
        for (const message of batch.messages) {
            try {
                await deliver(message.body);
            } catch {
                await ctx.queues.emailQueue.send(message.body);
            }
        }
    },
});
`,
        );

        expect(cycleFindings()).toHaveLength(0);
    });

    it("does not flag a re-enqueue that follows an early return in the same loop body", () => {
        expect.assertions(1);

        writeLunora(
            "queues.ts",
            `import { defineQueue } from "@lunora/queue";

export const emailQueue = defineQueue({
    handler: async (batch, ctx) => {
        for (const message of batch.messages) {
            if (message.body.done) return;
            await ctx.queues.emailQueue.send(message.body);
        }
    },
});
`,
        );

        expect(cycleFindings()).toHaveLength(0);
    });

    it("flags a topic cycle: a subscriber's batch loop publishes to the topic it receives", () => {
        expect.assertions(2);

        writeLunora(
            "queues.ts",
            `import { defineQueue, defineSubscription, defineTopic } from "@lunora/queue";

export const posted = defineTopic<{ text: string }>();
export const audit = defineSubscription(posted, {
    handler: async (batch, ctx) => {
        for (const message of batch.messages) {
            await ctx.topics.posted.publish(message.body);
        }
    },
});
`,
        );

        const findings = cycleFindings();

        expect(findings.map((finding) => finding.cacheKey)).toStrictEqual(["queue_dispatch_cycle:queue:audit,topic:posted"]);
        expect(findings[0]?.detail).toContain("`queue:audit` publishes to `topic:posted`");
    });
});
