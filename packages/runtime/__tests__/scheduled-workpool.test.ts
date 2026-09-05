import { describe, expect, it } from "vitest";

import { BRANCH_MARKER_REJECTION } from "../../../shared/branch-marker";
import { encodeWire } from "../../../shared/wire-codec";
import type { ExecutionContextLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";

const ADMIN = "s3cret-admin";

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const okShard = (): ShardNamespaceLike => {
    return {
        get: () => {
            return {
                fetch: async () => Response.json({ result: null }, { status: 200 }),
            };
        },
        idFromName: (name) => {
            return { __name: name };
        },
    };
};

interface SchedulerCall {
    body: { id?: string; pool?: string };
    instance: string;
    path: string;
}

interface SchedulerSpy {
    calls: SchedulerCall[];
    namespace: ShardNamespaceLike;
}

const schedulerSpy = (): SchedulerSpy => {
    const calls: SchedulerCall[] = [];

    const namespace: ShardNamespaceLike = {
        get: (id) => {
            const instance = (id as { __name: string }).__name;

            return {
                fetch: async (request: Request) => {
                    const body: { id?: string; pool?: string } = await request.clone().json();

                    calls.push({ body, instance, path: new URL(request.url).pathname });

                    return Response.json({ released: true }, { status: 200 });
                },
            };
        },
        idFromName: (name) => {
            return { __name: name };
        },
    };

    return { calls, namespace };
};

const dispatch = (worker: ReturnType<typeof createWorker>, body: Record<string, unknown>): Promise<Response> =>
    worker.fetch(
        new Request("https://app.example/_lunora/scheduler/dispatch", {
            body: JSON.stringify(body),
            headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
            method: "POST",
        }),
        {},
        fakeContext,
    );

describe("createWorker — workpool slot release", () => {
    it("releases a pooled job's slot via the routed SchedulerDO /complete", async () => {
        expect.assertions(3);

        const sched = schedulerSpy();
        const worker = createWorker({ adminToken: ADMIN, schedulerDO: sched.namespace, shardDO: okShard() });

        await dispatch(worker, { args: {}, functionPath: "jobs:sweep", id: "job-1", instanceName: "tenant-a", pool: "stripe" });

        const complete = sched.calls.find((call) => call.path === "/complete");

        expect(complete?.body).toStrictEqual({ id: "job-1", pool: "stripe" });
        expect(complete?.instance).toBe("tenant-a");
        expect(sched.calls.filter((call) => call.path === "/complete")).toHaveLength(1);
    });

    it("does not call /complete for a non-pooled job", async () => {
        expect.assertions(1);

        const sched = schedulerSpy();
        const worker = createWorker({ adminToken: ADMIN, schedulerDO: sched.namespace, shardDO: okShard() });

        await dispatch(worker, { args: {}, functionPath: "jobs:once", id: "job-2" });

        expect(sched.calls.some((call) => call.path === "/complete")).toBe(false);
    });
});

/** POST a dispatch body with a custom `env` (for the workflow-binding path). */
const dispatchWithEnv = (worker: ReturnType<typeof createWorker>, body: Record<string, unknown>, env: unknown): Promise<Response> =>
    worker.fetch(
        new Request("https://app.example/_lunora/scheduler/dispatch", {
            body: JSON.stringify(body),
            headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
            method: "POST",
        }),
        env,
        fakeContext,
    );

describe("createWorker — scheduled workflow/agent dispatch", () => {
    it("starts an instance of the workflow binding with the job args as params", async () => {
        expect.assertions(3);

        const created: { id?: string; params?: Record<string, unknown> }[] = [];
        const env = {
            AGENT_SUPPORT: {
                create: async (options: { id?: string; params?: Record<string, unknown> }) => {
                    created.push(options);

                    return { id: "wf-1" };
                },
            },
        };
        const sched = schedulerSpy();
        const worker = createWorker({ adminToken: ADMIN, schedulerDO: sched.namespace, shardDO: okShard() });

        const response = await dispatchWithEnv(worker, { args: { prompt: "digest" }, id: "job-3", workflow: "AGENT_SUPPORT" }, env);

        expect(response.status).toBe(200);
        // The binding is `create()`d with the scheduled args as its `params`, under
        // the record id as its instance id.
        expect(created).toStrictEqual([{ id: "job-3", params: { prompt: "digest" } }]);
        // This job carries no `pool`, so there is no slot to release.
        expect(sched.calls.some((call) => call.path === "/complete")).toBe(false);
    });

    it("decodes wire-encoded args before handing them to the workflow binding", async () => {
        expect.assertions(2);

        // `ctx.scheduler.runAt` stores `encodeWire(args)`. A FUNCTION target's args
        // are decoded by the shard; a workflow target never reaches the shard, so
        // without a decode here `event.payload` carried the raw tuples — a silent
        // corruption where the un-encoded version at least threw.
        const created: { params?: Record<string, unknown> }[] = [];
        const env = {
            AGENT_SUPPORT: {
                create: async (options: { params?: Record<string, unknown> }) => {
                    created.push(options);

                    return { id: "wf-2" };
                },
            },
        };
        const worker = createWorker({ adminToken: ADMIN, schedulerDO: schedulerSpy().namespace, shardDO: okShard() });

        const response = await dispatchWithEnv(
            worker,
            { args: encodeWire({ at: new Date(0), total: 9_007_199_254_740_993n }), id: "job-wire", workflow: "AGENT_SUPPORT" },
            env,
        );

        expect(response.status).toBe(200);
        expect(created[0]?.params).toStrictEqual({ at: new Date(0), total: 9_007_199_254_740_993n });
    });

    it("passes the scheduler record id as the workflow instance id so a re-fire is idempotent", async () => {
        expect.assertions(2);

        // The SchedulerDO's retry loop is at-least-once: a DO eviction, an edge
        // 502 or a transport blip after the origin already started the workflow
        // makes `dispatch()` report failure, `recordRetry` re-arms, and the SAME
        // record fires again — up to MAX_RETRY_ATTEMPTS times. Without an
        // instance id Cloudflare mints a fresh random one every call, so each
        // re-fire runs a second full pipeline. The record id is already on the
        // wire and already constrained to a safe key segment, which is exactly
        // what `create({ id })` accepts.
        const created: { id?: string; params?: Record<string, unknown> }[] = [];
        const env = {
            AGENT_SUPPORT: {
                create: async (options: { id?: string; params?: Record<string, unknown> }) => {
                    created.push(options);

                    return { id: options.id ?? "wf-1" };
                },
            },
        };
        const sched = schedulerSpy();
        const worker = createWorker({ adminToken: ADMIN, schedulerDO: sched.namespace, shardDO: okShard() });

        const response = await dispatchWithEnv(worker, { args: { prompt: "digest" }, id: "job-idem", workflow: "AGENT_SUPPORT" }, env);

        expect(response.status).toBe(200);
        expect(created).toStrictEqual([{ id: "job-idem", params: { prompt: "digest" } }]);
    });

    it("treats a duplicate-instance rejection as a successful dispatch and still releases the pool slot", async () => {
        expect.assertions(3);

        // The re-fire itself: the first attempt's create landed, so the second
        // one is rejected with "already exists". That is the idempotency signal,
        // not a failure — reporting it as a 500 would send the record back
        // through `recordRetry` and leave its pool slot held.
        const env = {
            AGENT_SUPPORT: {
                create: async (): Promise<never> => {
                    throw new Error('instance with id "job-idem" already exists');
                },
            },
        };
        const sched = schedulerSpy();
        const worker = createWorker({ adminToken: ADMIN, schedulerDO: sched.namespace, shardDO: okShard() });

        const response = await dispatchWithEnv(worker, { args: {}, id: "job-idem", instanceName: "tenant-a", pool: "digests", workflow: "AGENT_SUPPORT" }, env);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({ ok: true });
        expect(sched.calls.filter((call) => call.path === "/complete")).toHaveLength(1);
    });

    it("still fails a non-duplicate create rejection so the record stays retryable", async () => {
        expect.assertions(1);

        const env = {
            AGENT_SUPPORT: {
                create: async (): Promise<never> => {
                    throw new Error("Workflows service unavailable");
                },
            },
        };
        const sched = schedulerSpy();
        const worker = createWorker({ adminToken: ADMIN, schedulerDO: sched.namespace, shardDO: okShard() });

        const response = await dispatchWithEnv(worker, { args: {}, id: "job-boom", workflow: "AGENT_SUPPORT" }, env);

        expect(response.status).toBe(500);
    });

    it("releases the workpool slot of a POOLED workflow job", async () => {
        expect.assertions(3);

        // `Scheduler.runAt` accepts a `WorkflowReference` together with
        // `RunOptions.pool`, and the SchedulerDO's `reservePoolSlot` reserves for
        // any record carrying `pool` — so a workflow target DOES hold a slot. The
        // workflow branch used to return before the release, and with the default
        // `maxConcurrency: 1` that wedged the pool permanently: nothing
        // reconciles a missing `/complete`.
        const env = {
            AGENT_SUPPORT: {
                create: async () => {
                    return { id: "wf-1" };
                },
            },
        };
        const sched = schedulerSpy();
        const worker = createWorker({ adminToken: ADMIN, schedulerDO: sched.namespace, shardDO: okShard() });

        const response = await dispatchWithEnv(
            worker,
            { args: { prompt: "digest" }, id: "job-pooled", instanceName: "tenant-a", pool: "digests", workflow: "AGENT_SUPPORT" },
            env,
        );

        const complete = sched.calls.find((call) => call.path === "/complete");

        expect(response.status).toBe(200);
        expect(complete?.body).toStrictEqual({ id: "job-pooled", pool: "digests" });
        expect(complete?.instance).toBe("tenant-a");
    });

    it("fails with a 500 when the workflow binding is missing from env", async () => {
        expect.assertions(1);

        const sched = schedulerSpy();
        const worker = createWorker({ adminToken: ADMIN, schedulerDO: sched.namespace, shardDO: okShard() });

        const response = await dispatchWithEnv(worker, { args: {}, id: "job-4", workflow: "AGENT_MISSING" }, {});

        expect(response.status).toBe(500);
    });

    it("rejects (400) scheduled workflow args carrying the reserved branch-marker key, and never calls create()", async () => {
        expect.assertions(3);

        const created: { params?: Record<string, unknown> }[] = [];
        const env = {
            AGENT_SUPPORT: {
                create: async (options: { params?: Record<string, unknown> }) => {
                    created.push(options);

                    return { id: "wf-1" };
                },
            },
        };
        const sched = schedulerSpy();
        const worker = createWorker({ adminToken: ADMIN, schedulerDO: sched.namespace, shardDO: okShard() });

        // A forged marker in the scheduled args (e.g. forwarded from a public
        // mutation's `ctx.scheduler.runAfter(workflowRef, args)`) must be rejected
        // at this trust boundary, the same as every other workflow create surface.
        const response = await dispatchWithEnv(
            worker,
            {
                args: { __lunoraBranch: { eventType: "lunora:branch:x", index: 0, parentBinding: "WORKFLOW_X", parentId: "p" }, prompt: "digest" },
                id: "job-5",
                workflow: "AGENT_SUPPORT",
            },
            env,
        );

        expect(response.status).toBe(400);
        expect(created).toHaveLength(0);

        // Shared across all five create-surface rejections (plan 262 review) —
        // the runtime's message must carry the same reason text as
        // workflow/agent/do, not just the same status code.
        const body: { error: { message: string } } = await response.json();

        expect(body.error.message).toContain(BRANCH_MARKER_REJECTION);
    });

    it("starts an ordinary scheduled workflow unaffected by the branch-marker guard", async () => {
        expect.assertions(2);

        const created: { id?: string; params?: Record<string, unknown> }[] = [];
        const env = {
            AGENT_SUPPORT: {
                create: async (options: { id?: string; params?: Record<string, unknown> }) => {
                    created.push(options);

                    return { id: "wf-1" };
                },
            },
        };
        const sched = schedulerSpy();
        const worker = createWorker({ adminToken: ADMIN, schedulerDO: sched.namespace, shardDO: okShard() });

        const response = await dispatchWithEnv(worker, { args: { prompt: "digest" }, id: "job-6", workflow: "AGENT_SUPPORT" }, env);

        expect(response.status).toBe(200);
        expect(created).toStrictEqual([{ id: "job-6", params: { prompt: "digest" } }]);
    });
});
