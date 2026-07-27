import { describe, expect, it, vi } from "vitest";

import type { PushBroadcastJob } from "../src/queue";
import { enqueuePushBroadcast, runPushBroadcastJob } from "../src/queue";
import type { LunoraPush } from "../src/types";

describe("queue-backed fan-out", () => {
    it("enqueues a typed broadcast job", async () => {
        expect.hasAssertions();

        const sent: PushBroadcastJob[] = [];
        const queue = {
            send: async (body: PushBroadcastJob) => {
                sent.push(body);
            },
        };

        await enqueuePushBroadcast(queue, { filter: { userId: "u1" }, payload: { body: "hi", title: "t" } });

        expect(sent).toStrictEqual([{ filter: { userId: "u1" }, payload: { body: "hi", title: "t" }, type: "lunora.push.broadcast" }]);
    });

    it("runs an enqueued job through push.broadcast", async () => {
        expect.hasAssertions();

        const broadcast = vi.fn().mockResolvedValue({ failed: 0, outcomes: [], pruned: 0, sent: 0, total: 0 });
        const push = { broadcast } as unknown as LunoraPush;
        const job: PushBroadcastJob = { payload: { body: "hi" }, type: "lunora.push.broadcast" };

        await runPushBroadcastJob(push, job);

        expect(broadcast).toHaveBeenCalledWith(job.payload, undefined);
    });

    it("rejects a job with a transient failure so the queue retries", async () => {
        expect.hasAssertions();

        // Any `failed > 0` is a transient batch failure worth another attempt —
        // re-thrown so the queue does NOT ack it.
        const broadcast = vi.fn().mockResolvedValue({ failed: 2, outcomes: [], pruned: 0, sent: 0, total: 2 });
        const push = { broadcast } as unknown as LunoraPush;
        const job: PushBroadcastJob = { payload: { body: "hi" }, type: "lunora.push.broadcast" };

        await expect(runPushBroadcastJob(push, job)).rejects.toThrow(/transient failure/u);
    });

    it("rejects a partial success that still had a transient failure", async () => {
        expect.hasAssertions();

        // `sent > 0` but `failed > 0`: the failed recipients are worth a retry, so the
        // whole batch is re-thrown (retry re-runs the full, non-idempotent broadcast).
        const broadcast = vi.fn().mockResolvedValue({ failed: 1, outcomes: [], pruned: 0, sent: 1, total: 2 });
        const push = { broadcast } as unknown as LunoraPush;
        const job: PushBroadcastJob = { payload: { body: "hi" }, type: "lunora.push.broadcast" };

        await expect(runPushBroadcastJob(push, job)).rejects.toThrow(/transient failure/u);
    });

    it("does NOT throw when the whole audience was pruned (a successful prune, not a failure)", async () => {
        expect.hasAssertions();

        // Every device had unsubscribed: `sent:0`, `failed:0`, `pruned:N`. That is a
        // SUCCESSFUL prune of a fully-unsubscribed audience — throwing on it would
        // spuriously retry and pressure the DLQ, so it must resolve (ack).
        const broadcast = vi.fn().mockResolvedValue({ failed: 0, outcomes: [], pruned: 3, sent: 0, total: 3 });
        const push = { broadcast } as unknown as LunoraPush;
        const job: PushBroadcastJob = { payload: { body: "hi" }, type: "lunora.push.broadcast" };

        await expect(runPushBroadcastJob(push, job)).resolves.toMatchObject({ pruned: 3, sent: 0 });
    });

    it("resolves for an empty audience — nothing to retry", async () => {
        expect.hasAssertions();

        const broadcast = vi.fn().mockResolvedValue({ failed: 0, outcomes: [], pruned: 0, sent: 0, total: 0 });
        const push = { broadcast } as unknown as LunoraPush;
        const job: PushBroadcastJob = { payload: { body: "hi" }, type: "lunora.push.broadcast" };

        await expect(runPushBroadcastJob(push, job)).resolves.toMatchObject({ total: 0 });
    });
});
