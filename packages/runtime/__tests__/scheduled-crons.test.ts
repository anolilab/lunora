import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExecutionContextLike, ShardCaller } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";

interface ShardSpy {
    calls: { body: unknown; shardKey: string }[];
    namespace: ShardNamespaceLike;
    response: Response;
}

const createShardSpy = (response = new Response("ok", { status: 200 })): ShardSpy => {
    const calls: { body: unknown; shardKey: string }[] = [];

    const spy = { calls, response } as ShardSpy;

    spy.namespace = {
        get: (id) => {
            const shardKey = (id as { __name: string }).__name;

            return {
                fetch: async (request: Request) => {
                    calls.push({ body: await request.clone().json(), shardKey });

                    return spy.response;
                },
            };
        },
        idFromName: (name) => {
            return { __name: name };
        },
    };

    return spy;
};

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const CRON = "*/30 * * * *";

describe("createWorker — code-defined cron jobs", () => {
    it("dispatches every job declared under the firing expression to the shard", async () => {
        expect.assertions(4);

        const shard = createShardSpy();
        const worker = createWorker({
            cronJobs: {
                [CRON]: [
                    { args: { reason: "tick" }, functionPath: "presence:clear", name: "clear presence" },
                    { args: {}, functionPath: "digests:flush", name: "flush digests" },
                ],
            },
            shardDO: shard.namespace,
        });

        await worker.scheduled({ cron: CRON, scheduledTime: 0 }, {}, fakeContext);

        expect(shard.calls).toHaveLength(2);
        expect(shard.calls[0]?.body).toStrictEqual({ args: { reason: "tick" }, functionPath: "presence:clear" });
        expect(shard.calls[1]?.body).toStrictEqual({ args: {}, functionPath: "digests:flush" });
        // Jobs without an explicit shardKey land on the default root shard.
        expect(shard.calls[0]?.shardKey).toBe("__root__");
    });

    it("does not dispatch jobs for a non-firing expression", async () => {
        expect.assertions(1);

        const shard = createShardSpy();
        const worker = createWorker({
            cronJobs: { [CRON]: [{ args: {}, functionPath: "presence:clear", name: "clear presence" }] },
            shardDO: shard.namespace,
        });

        await worker.scheduled({ cron: "0 0 * * *", scheduledTime: 0 }, {}, fakeContext);

        expect(shard.calls).toHaveLength(0);
    });

    it("routes a job to its explicit shardKey", async () => {
        expect.assertions(1);

        const shard = createShardSpy();
        const worker = createWorker({
            cronJobs: { [CRON]: [{ args: {}, functionPath: "tenant:sweep", name: "sweep", shardKey: "tenant-7" }] },
            shardDO: shard.namespace,
        });

        await worker.scheduled({ cron: CRON, scheduledTime: 0 }, {}, fakeContext);

        expect(shard.calls[0]?.shardKey).toBe("tenant-7");
    });

    it("rethrows when a dispatched job fails so the platform sees the cron invocation fail", async () => {
        expect.assertions(1);

        const shard = createShardSpy(new Response("boom", { status: 500 }));
        const worker = createWorker({
            cronJobs: { [CRON]: [{ args: {}, functionPath: "presence:clear", name: "clear presence" }] },
            shardDO: shard.namespace,
        });

        await expect(worker.scheduled({ cron: CRON, scheduledTime: 0 }, {}, fakeContext)).rejects.toThrow(/clear presence/u);
    });

    it("starts a workflow instance for a workflow-targeting cron job", async () => {
        expect.assertions(3);

        const shard = createShardSpy();
        const created: { params?: unknown }[] = [];
        const env = {
            WORKFLOW_DIGEST: {
                create: async (options?: { params?: unknown }) => {
                    created.push(options ?? {});

                    return { id: "wf-1" };
                },
            },
        };

        const worker = createWorker({
            cronJobs: { [CRON]: [{ args: { region: "eu" }, name: "nightly digest", workflow: "WORKFLOW_DIGEST" }] },
            shardDO: shard.namespace,
        });

        await worker.scheduled({ cron: CRON, scheduledTime: 0 }, env, fakeContext);

        // The workflow binding's create() is called with args as params; no shard dispatch.
        expect(created).toStrictEqual([{ params: { region: "eu" } }]);
        expect(shard.calls).toHaveLength(0);
        expect(created).toHaveLength(1);
    });

    it("fails the cron invocation when a workflow-targeting job's binding is missing", async () => {
        expect.assertions(1);

        const shard = createShardSpy();
        const worker = createWorker({
            cronJobs: { [CRON]: [{ args: {}, name: "nightly digest", workflow: "WORKFLOW_MISSING" }] },
            shardDO: shard.namespace,
        });

        await expect(worker.scheduled({ cron: CRON, scheduledTime: 0 }, {}, fakeContext)).rejects.toThrow(/WORKFLOW_MISSING/u);
    });

    it("warns when a firing cron expression matches nothing at all", async () => {
        expect.assertions(3);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        try {
            const shard = createShardSpy();
            const worker = createWorker({
                cronJobs: { [CRON]: [{ args: {}, functionPath: "presence:clear", name: "clear presence" }] },
                shardDO: shard.namespace,
            });

            // `wrangler.jsonc`'s triggers.crons drifted from the generated map:
            // Cloudflare fires this expression, nothing is registered under it,
            // and without the warning the invocation is a silent success.
            await worker.scheduled({ cron: "0 0 * * *", scheduledTime: 0 }, {}, fakeContext);

            const message = warn.mock.calls.flat().join(" ");

            expect(shard.calls).toHaveLength(0);
            expect(message).toContain("0 0 * * *");
            expect(message).toContain(CRON);
        } finally {
            warn.mockRestore();
        }
    });

    it("does not warn when the firing expression did run a job", async () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        try {
            const shard = createShardSpy();
            const worker = createWorker({
                cronJobs: { [CRON]: [{ args: {}, functionPath: "presence:clear", name: "clear presence" }] },
                shardDO: shard.namespace,
            });

            await worker.scheduled({ cron: CRON, scheduledTime: 0 }, {}, fakeContext);

            expect(shard.calls).toHaveLength(1);
            expect(warn.mock.calls.flat().join(" ")).not.toContain("no cron handler");
        } finally {
            warn.mockRestore();
        }
    });
});

describe("createWorker — `authorizeShard` gates callers, never system dispatch", () => {
    // The natural gate an app writes: reaching a shard requires a signed-in user.
    // It must hold for end users AND leave server-initiated dispatch alone — a
    // gate that cannot tell "anonymous end user" from "the scheduler" silently
    // 403s every cron with the DO retrying forever.
    const requireSignedInUser = vi.fn<(caller: ShardCaller) => boolean>(({ identity }) => identity?.userId !== undefined);

    const rpcRequest = (envelope: Record<string, unknown>): Request =>
        new Request("https://app.example/_lunora/rpc", { body: JSON.stringify(envelope), method: "POST" });

    beforeEach(() => {
        requireSignedInUser.mockClear();
    });

    it("dispatches a firing cron job to a shard whose gate rejects every anonymous end user", async () => {
        expect.assertions(3);

        const shard = createShardSpy();
        const worker = createWorker({
            authorizeShard: requireSignedInUser,
            cronJobs: { [CRON]: [{ args: {}, functionPath: "presence:clear", name: "clear presence", shardKey: "tenant-7" }] },
            shardDO: shard.namespace,
        });

        await worker.scheduled({ cron: CRON, scheduledTime: 0 }, {}, fakeContext);

        expect(shard.calls).toHaveLength(1);
        expect(shard.calls[0]?.shardKey).toBe("tenant-7");
        // The caller gate is not consulted at all for system dispatch.
        expect(requireSignedInUser).not.toHaveBeenCalled();
    });

    it("dispatches an HMAC/bearer-authenticated scheduler job through the same gate", async () => {
        expect.assertions(2);

        const shard = createShardSpy();
        const worker = createWorker({
            adminToken: "admin-secret",
            authorizeShard: requireSignedInUser,
            shardDO: shard.namespace,
        });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/scheduler/dispatch", {
                body: JSON.stringify({ args: {}, functionPath: "digests:flush", id: "job-1", shardKey: "tenant-7" }),
                headers: { authorization: "Bearer admin-secret" }, // gitleaks:allow -- test fixture bearer, matches the stub admin token below
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);
        expect(shard.calls[0]?.shardKey).toBe("tenant-7");
    });

    it("refuses a wrong bearer with DISPATCH_UNAUTHENTICATED, not the per-call FORBIDDEN", async () => {
        expect.assertions(3);

        const shard = createShardSpy();
        const worker = createWorker({ adminToken: "admin-secret", shardDO: shard.namespace });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/scheduler/dispatch", {
                body: JSON.stringify({ args: {}, functionPath: "digests:flush", id: "job-1", shardKey: "tenant-7" }),
                headers: { authorization: "Bearer stale-secret" }, // gitleaks:allow -- test fixture bearer, deliberately not the admin token above
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(403);
        // The code is what dispatch consumers classify on: a rotated token fails
        // every message identically, so it must stay retryable rather than being
        // acked as a poison message.
        await expect(response.json()).resolves.toMatchObject({ error: { code: "DISPATCH_UNAUTHENTICATED" } });
        expect(shard.calls).toHaveLength(0);
    });

    it("still rejects an anonymous end user with that same gate", async () => {
        expect.assertions(3);

        const shard = createShardSpy();
        const worker = createWorker({ authorizeShard: requireSignedInUser, shardDO: shard.namespace });

        const response = await worker.fetch(rpcRequest({ args: {}, functionPath: "presence:list", shardKey: "tenant-7" }), {}, fakeContext);

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN_SHARD" } });
        expect(shard.calls).toHaveLength(0);
    });

    it("still allows an authenticated end user through that same gate", async () => {
        expect.assertions(3);

        const shard = createShardSpy();
        const worker = createWorker({
            authorizeShard: requireSignedInUser,
            resolveIdentity: () => {
                return { userId: "user_42" };
            },
            shardDO: shard.namespace,
        });

        const response = await worker.fetch(rpcRequest({ args: {}, functionPath: "presence:list", shardKey: "tenant-7" }), {}, fakeContext);

        expect(response.status).toBe(200);
        expect(shard.calls).toHaveLength(1);
        expect(requireSignedInUser).toHaveBeenCalledWith({ identity: { userId: "user_42" }, shardKey: "tenant-7" });
    });
});
