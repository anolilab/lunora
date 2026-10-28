import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExecutionContextLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const CRON = "*/5 * * * *";
const ADMIN_TOKEN = "admin-bear";

/** A shard whose dispatches block until the test releases them, so "is a run still in flight?" is deterministic; `entered` resolves once one has begun. */
const blockingShard = (status = 200): { entered: Promise<void>; namespace: ShardNamespaceLike; release: () => void; started: number } => {
    const waiting: (() => void)[] = [];
    let markEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
        markEntered = resolve;
    });
    const shard = {
        entered,
        namespace: {
            get: () => {
                return {
                    fetch: async () => {
                        shard.started += 1;
                        markEntered();
                        await new Promise<void>((resolve) => {
                            waiting.push(resolve);
                        });

                        return new Response("{}", { status });
                    },
                };
            },
            idFromName: (name: string) => {
                return { __name: name };
            },
        } satisfies ShardNamespaceLike,
        release: () => {
            for (const resume of waiting.splice(0)) {
                resume();
            }
        },
        started: 0,
    };

    return shard;
};

/** The SchedulerDO's `/cron/begin` / `/cron/end` contract, in memory, recording every call. */
const leaseScheduler = (failWith?: number): { calls: { body: Record<string, unknown>; path: string }[]; namespace: ShardNamespaceLike } => {
    const calls: { body: Record<string, unknown>; path: string }[] = [];
    const held = new Set<string>();

    return {
        calls,
        namespace: {
            get: () => {
                return {
                    fetch: async (request: Request) => {
                        const path = new URL(request.url).pathname;
                        const body: Record<string, unknown> = await request.json();
                        const name = String(body.name);

                        calls.push({ body, path });

                        if (failWith !== undefined) {
                            return new Response("down", { status: failWith });
                        }

                        if (path === "/cron/begin") {
                            if (held.has(name)) {
                                return Response.json({ acquired: false, reason: "in-flight" });
                            }

                            held.add(name);

                            return Response.json({ acquired: true, runId: `run-${String(calls.length)}` });
                        }

                        held.delete(name);

                        return Response.json({ recorded: true });
                    },
                };
            },
            idFromName: (name: string) => {
                return { __name: name };
            },
        },
    };
};

describe("createWorker — cron overlap guard", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("skips a tick while the previous run of the same job is still in flight", async () => {
        expect.hasAssertions();

        const shard = blockingShard();
        const scheduler = leaseScheduler();
        const worker = createWorker({
            cronJobs: { [CRON]: [{ functionPath: "digest:send", name: "digest" }] },
            schedulerDO: scheduler.namespace,
            shardDO: shard.namespace,
        });

        const first = worker.scheduled({ cron: CRON, scheduledTime: 0 }, {}, fakeContext);

        await shard.entered;
        await worker.scheduled({ cron: CRON, scheduledTime: 300_000 }, {}, fakeContext);

        expect(shard.started).toBe(1);

        shard.release();
        await first;

        expect(scheduler.calls.map((call) => call.path)).toStrictEqual(["/cron/begin", "/cron/begin", "/cron/end"]);
        expect(scheduler.calls[2]?.body).toStrictEqual({ name: "digest", runId: "run-1", status: "succeeded" });
    });

    it("records a failed run with its error and still fails the invocation", async () => {
        expect.hasAssertions();

        const shard = blockingShard(500);
        const scheduler = leaseScheduler();
        const worker = createWorker({
            cronJobs: { [CRON]: [{ functionPath: "digest:send", name: "digest" }] },
            schedulerDO: scheduler.namespace,
            shardDO: shard.namespace,
        });

        const fire = worker.scheduled({ cron: CRON, scheduledTime: 0 }, {}, fakeContext);

        await shard.entered;
        shard.release();

        await expect(fire).rejects.toThrow("failed with shard status 500");
        expect(scheduler.calls.at(-1)?.body).toMatchObject({ name: "digest", status: "failed" });
        expect(String(scheduler.calls.at(-1)?.body.error)).toContain("shard status 500");
    });

    it("runs unguarded when the scheduler cannot be reached, rather than stopping the cron", async () => {
        expect.hasAssertions();

        vi.spyOn(console, "warn").mockImplementation(() => undefined);

        const shard = blockingShard();
        const worker = createWorker({
            cronJobs: { [CRON]: [{ functionPath: "digest:send", name: "digest" }] },
            schedulerDO: leaseScheduler(503).namespace,
            shardDO: shard.namespace,
        });

        const fire = worker.scheduled({ cron: CRON, scheduledTime: 0 }, {}, fakeContext);

        await shard.entered;

        expect(shard.started).toBe(1);

        shard.release();
        await fire;
    });

    it("refuses a manual run (409) while the job is already running", async () => {
        expect.hasAssertions();

        const shard = blockingShard();
        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            cronJobs: { [CRON]: [{ functionPath: "digest:send", name: "digest" }] },
            schedulerDO: leaseScheduler().namespace,
            shardDO: shard.namespace,
        });

        const fire = worker.scheduled({ cron: CRON, scheduledTime: 0 }, {}, fakeContext);

        await shard.entered;

        const manual = await worker.fetch(
            new Request("https://app.example/_lunora/admin/cron-jobs/run", {
                body: JSON.stringify({ name: "digest" }),
                headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(manual.status).toBe(409);
        await expect(manual.json()).resolves.toMatchObject({ error: { code: "CRON_JOB_IN_FLIGHT" } });

        shard.release();
        await fire;
    });
});
