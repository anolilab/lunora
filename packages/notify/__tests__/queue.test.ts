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

    it("rejects a job that delivered to nobody so the queue retries", async () => {
        expect.hasAssertions();

        // A non-empty audience where nothing was sent (all failed) is a transient
        // batch failure — re-thrown so the queue does NOT ack it.
        const broadcast = vi.fn().mockResolvedValue({ failed: 2, outcomes: [], pruned: 0, sent: 0, total: 2 });
        const push = { broadcast } as unknown as LunoraPush;
        const job: PushBroadcastJob = { payload: { body: "hi" }, type: "lunora.push.broadcast" };

        await expect(runPushBroadcastJob(push, job)).rejects.toThrow(/delivered to none/u);
    });

    it("resolves on partial success — an acked partial batch is not retried", async () => {
        expect.hasAssertions();

        // `sent > 0`: retrying would re-send to the already-delivered recipients, so
        // a partial success resolves (acks) rather than throwing.
        const broadcast = vi.fn().mockResolvedValue({ failed: 1, outcomes: [], pruned: 0, sent: 1, total: 2 });
        const push = { broadcast } as unknown as LunoraPush;
        const job: PushBroadcastJob = { payload: { body: "hi" }, type: "lunora.push.broadcast" };

        await expect(runPushBroadcastJob(push, job)).resolves.toMatchObject({ sent: 1 });
    });

    it("resolves for an empty audience — nothing to retry", async () => {
        expect.hasAssertions();

        const broadcast = vi.fn().mockResolvedValue({ failed: 0, outcomes: [], pruned: 0, sent: 0, total: 0 });
        const push = { broadcast } as unknown as LunoraPush;
        const job: PushBroadcastJob = { payload: { body: "hi" }, type: "lunora.push.broadcast" };

        await expect(runPushBroadcastJob(push, job)).resolves.toMatchObject({ total: 0 });
    });
});
