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

    it("runs an enqueued job through push.broadcastPage (ONE bounded page, not the whole audience)", async () => {
        expect.hasAssertions();

        const broadcastPage = vi.fn().mockResolvedValue({ nextCursor: undefined, result: { failed: 0, outcomes: [], pruned: 0, sent: 0, total: 0 } });
        const push = { broadcastPage } as unknown as LunoraPush;
        const job: PushBroadcastJob = { payload: { body: "hi" }, type: "lunora.push.broadcast" };

        await runPushBroadcastJob(push, job);

        expect(broadcastPage).toHaveBeenCalledWith(job.payload, undefined);
    });

    it("rejects a job with a transient failure so the queue retries JUST this page", async () => {
        expect.hasAssertions();

        // Any `result.failed > 0` is a transient page failure worth another
        // attempt — re-thrown so the queue does NOT ack it.
        const broadcastPage = vi.fn().mockResolvedValue({ nextCursor: undefined, result: { failed: 2, outcomes: [], pruned: 0, sent: 0, total: 2 } });
        const push = { broadcastPage } as unknown as LunoraPush;
        const job: PushBroadcastJob = { payload: { body: "hi" }, type: "lunora.push.broadcast" };

        await expect(runPushBroadcastJob(push, job)).rejects.toThrow(/transient failure/u);
    });

    it("rejects a partial success that still had a transient failure", async () => {
        expect.hasAssertions();

        // `sent > 0` but `failed > 0`: the failed recipients are worth a retry, so
        // this page's job is re-thrown (retry re-runs the page, not the whole broadcast).
        const broadcastPage = vi.fn().mockResolvedValue({ nextCursor: undefined, result: { failed: 1, outcomes: [], pruned: 0, sent: 1, total: 2 } });
        const push = { broadcastPage } as unknown as LunoraPush;
        const job: PushBroadcastJob = { payload: { body: "hi" }, type: "lunora.push.broadcast" };

        await expect(runPushBroadcastJob(push, job)).rejects.toThrow(/transient failure/u);
    });

    it("does NOT throw when the whole page was pruned (a successful prune, not a failure)", async () => {
        expect.hasAssertions();

        // Every device on this page had unsubscribed: `sent:0`, `failed:0`, `pruned:N`.
        // That is a SUCCESSFUL prune, not a failure, so throwing on it would
        // spuriously retry and pressure the DLQ — it must resolve (ack).
        const broadcastPage = vi.fn().mockResolvedValue({ nextCursor: undefined, result: { failed: 0, outcomes: [], pruned: 3, sent: 0, total: 3 } });
        const push = { broadcastPage } as unknown as LunoraPush;
        const job: PushBroadcastJob = { payload: { body: "hi" }, type: "lunora.push.broadcast" };

        await expect(runPushBroadcastJob(push, job)).resolves.toMatchObject({ result: { pruned: 3, sent: 0 } });
    });

    it("resolves for an empty page — nothing to retry", async () => {
        expect.hasAssertions();

        const broadcastPage = vi.fn().mockResolvedValue({ nextCursor: undefined, result: { failed: 0, outcomes: [], pruned: 0, sent: 0, total: 0 } });
        const push = { broadcastPage } as unknown as LunoraPush;
        const job: PushBroadcastJob = { payload: { body: "hi" }, type: "lunora.push.broadcast" };

        await expect(runPushBroadcastJob(push, job)).resolves.toMatchObject({ result: { total: 0 } });
    });

    it("surfaces nextCursor so the caller can enqueue the continuation page", async () => {
        expect.hasAssertions();

        const broadcastPage = vi
            .fn()
            .mockResolvedValue({ nextCursor: "wp2_deadbeefdeadbeef", result: { failed: 0, outcomes: [], pruned: 0, sent: 5, total: 5 } });
        const push = { broadcastPage } as unknown as LunoraPush;
        const job: PushBroadcastJob = { payload: { body: "hi" }, type: "lunora.push.broadcast" };

        const outcome = await runPushBroadcastJob(push, job);

        expect(outcome.nextCursor).toBe("wp2_deadbeefdeadbeef");
    });

    it("a job carrying a cursor resumes broadcastPage with that cursor as `filter.after`", async () => {
        expect.hasAssertions();

        const broadcastPage = vi.fn().mockResolvedValue({ nextCursor: undefined, result: { failed: 0, outcomes: [], pruned: 0, sent: 1, total: 1 } });
        const push = { broadcastPage } as unknown as LunoraPush;
        const job: PushBroadcastJob = { filter: { after: "wp2_1111111111111111", userId: "u1" }, payload: { body: "hi" }, type: "lunora.push.broadcast" };

        await runPushBroadcastJob(push, job);

        expect(broadcastPage).toHaveBeenCalledWith(job.payload, { after: "wp2_1111111111111111", userId: "u1" });
    });
});
