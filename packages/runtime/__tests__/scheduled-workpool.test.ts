import { describe, expect, it } from "vitest";

import type { ExecutionContextLike } from "../src/create-worker.js";
import { createWorker } from "../src/create-worker.js";
import type { ShardNamespaceLike } from "../src/resolve-shard.js";

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
        new Request("https://app.example/_cirrus/scheduler/dispatch", {
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
