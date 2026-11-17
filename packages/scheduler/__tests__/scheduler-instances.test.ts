import { afterEach, describe, expect, it, vi } from "vitest";

import createScheduler from "../src/create-scheduler";
import createWorkpool from "../src/create-workpool";
import { SchedulerDO } from "../src/scheduler-do";
import type { DurableObjectNamespaceLike, ScheduleRecord } from "../src/types";
import { post } from "./blocking-scheduler";
import { createFakeState } from "./fake-state";

const env = { LUNORA_ORIGIN_URL: "https://app.test" };

class Recording extends SchedulerDO {
    public readonly dispatched: string[] = [];

    protected override async dispatch(record: ScheduleRecord): Promise<boolean> {
        this.dispatched.push(record.id);

        return true;
    }
}

/** A namespace of real SchedulerDO instances, one per name, each on its own storage. */
const namespaceOf = (): {
    instances: Map<string, { scheduler: Recording; state: ReturnType<typeof createFakeState> }>;
    namespace: DurableObjectNamespaceLike;
    requests: string[];
} => {
    const instances = new Map<string, { scheduler: Recording; state: ReturnType<typeof createFakeState> }>();
    const requests: string[] = [];
    const instance = (name: string): { scheduler: Recording; state: ReturnType<typeof createFakeState> } => {
        let found = instances.get(name);

        if (found === undefined) {
            const state = createFakeState();

            found = { scheduler: new Recording(state, env), state };
            instances.set(name, found);
        }

        return found;
    };

    return {
        instances,
        namespace: {
            get: (id) => {
                const name = id.toString();

                return {
                    fetch: async (input: Request | string, init?: RequestInit) => {
                        const request = typeof input === "string" ? new Request(input, init) : input;

                        requests.push(`${name} ${request.method} ${new URL(request.url).pathname}`);

                        return instance(name).scheduler.fetch(request);
                    },
                };
            },
            idFromName: (name) => {
                return { toString: () => name };
            },
        },
        requests,
    };
};

const JOB = { __lunoraRef: "jobs:run" } as never;

const listInstances = async (scheduler: SchedulerDO): Promise<string[]> => {
    const response = await scheduler.fetch(new Request("https://scheduler.internal/instances"));
    const body = await response.json<{ instances: string[] }>();

    return body.instances.toSorted((left, right) => left.localeCompare(right));
};

describe("schedulerDO instance registry", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("keeps a registered name durably, once, across a new instance of the class", async () => {
        expect.hasAssertions();

        const state = createFakeState();
        const first = new SchedulerDO(state, env);

        await first.fetch(post("/instances/register", { name: "tenant-a" }));
        await first.fetch(post("/instances/register", { name: "tenant-a" }));
        await first.fetch(post("/instances/register", { name: "tenant:b" }));

        // The class is evicted and rebuilt on the same storage.
        await expect(listInstances(new SchedulerDO(state, env))).resolves.toStrictEqual(["tenant-a", "tenant:b"]);
    });

    it("answers a registration with the pause state it was taken under", async () => {
        expect.hasAssertions();

        vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

        const scheduler = new SchedulerDO(createFakeState(), env);
        const running = await scheduler.fetch(post("/instances/register", { name: "tenant-a" }));

        await expect(running.json()).resolves.toStrictEqual({ paused: false });

        await scheduler.fetch(post("/pause", { paused: true, reason: "incident 42" }));

        const paused = await scheduler.fetch(post("/instances/register", { name: "tenant-b" }));

        await expect(paused.json()).resolves.toStrictEqual({ paused: true, pausedAt: 1_700_000_000_000, reason: "incident 42" });
    });

    it("refuses a registration without a name", async () => {
        expect.hasAssertions();

        const response = await new SchedulerDO(createFakeState(), env).fetch(post("/instances/register", {}));

        expect(response.status).toBe(400);
    });
});

describe("a named scheduler instance", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("registers with the default instance the first time it is addressed, and only then", async () => {
        expect.hasAssertions();

        const { instances, namespace, requests } = namespaceOf();
        const scheduler = createScheduler({ instanceName: "tenant-a", namespace });

        await scheduler.runAfter(60_000, JOB, {} as never);
        await scheduler.runAfter(60_000, JOB, {} as never);

        await expect(listInstances((instances.get("default") as { scheduler: SchedulerDO }).scheduler)).resolves.toStrictEqual(["tenant-a"]);
        expect(requests.filter((request) => request.endsWith("/instances/register"))).toStrictEqual(["default POST /instances/register"]);
    });

    it("never registers the default instance with itself", async () => {
        expect.hasAssertions();

        const { namespace, requests } = namespaceOf();

        await createScheduler({ namespace }).runAfter(60_000, JOB, {} as never);

        expect(requests.some((request) => request.includes("/instances"))).toBe(false);
    });

    it("starts paused when it is first addressed during a pause, and holds its job", async () => {
        expect.hasAssertions();

        vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

        const { instances, namespace } = namespaceOf();

        await namespace.get(namespace.idFromName("default")).fetch(post("/pause", { paused: true, reason: "incident 42" }));

        const scheduler = createScheduler({ instanceName: "tenant-a", namespace });

        await scheduler.runAt(Date.now() - 1000, JOB, {} as never);

        const tenant = instances.get("tenant-a") as { scheduler: Recording };
        const state = await tenant.scheduler.fetch(new Request("https://scheduler.internal/pause"));

        await expect(state.json()).resolves.toMatchObject({ paused: true, reason: "incident 42" });

        await tenant.scheduler.alarm();

        expect(tenant.scheduler.dispatched).toStrictEqual([]);
    });

    it("registers a workpool's instance the same way", async () => {
        expect.hasAssertions();

        const { instances, namespace } = namespaceOf();
        const pool = createWorkpool({ instanceName: "tenant-pool", maxConcurrency: 1, name: "emails", namespace });

        await pool.enqueue(JOB, {} as never).catch(() => undefined);

        await expect(listInstances((instances.get("default") as { scheduler: SchedulerDO }).scheduler)).resolves.toStrictEqual(["tenant-pool"]);
    });

    it("fails the call, rather than running unregistered, when the default instance cannot be reached", async () => {
        expect.hasAssertions();

        const namespace: DurableObjectNamespaceLike = {
            get: (id) => {
                return {
                    fetch: async () => {
                        if (id.toString() === "default") {
                            throw new Error("scheduler down");
                        }

                        return Response.json({ id: "x", scheduledFor: 1 });
                    },
                };
            },
            idFromName: (name) => {
                return { toString: () => name };
            },
        };

        await expect(createScheduler({ instanceName: "tenant-a", namespace }).runAfter(60_000, JOB, {} as never)).rejects.toThrow("scheduler down");
    });
});
