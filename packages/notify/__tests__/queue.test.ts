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

    it("returns the page (cursor included) instead of throwing when some recipients failed", async () => {
        expect.hasAssertions();

        // Regression: throwing discarded `nextCursor`, so one permanently-failing
        // device stalled the broadcast forever — every retry re-POSTed the
        // recipients this page already delivered to, then dead-lettered, and the
        // later pages were never reached.
        const broadcastPage = vi.fn().mockResolvedValue({
            nextCursor: "wp2_page2",
            result: {
                failed: 1,
                outcomes: [
                    { id: "a", status: "ok" },
                    { id: "b", error: "403 VapidPkHashMismatch", status: "failed" },
                ],
                pruned: 0,
                sent: 1,
                total: 2,
            },
        });
        const push = { broadcastPage } as unknown as LunoraPush;
        const job: PushBroadcastJob = { payload: { body: "hi" }, type: "lunora.push.broadcast" };

        const outcome = await runPushBroadcastJob(push, job);

        expect(outcome.nextCursor).toBe("wp2_page2");
        expect(outcome.failedIds).toStrictEqual(["b"]);
    });

    it("a retryIds job redelivers to exactly those ids and never walks a page", async () => {
        expect.hasAssertions();

        const broadcastPage = vi.fn();
        const send = vi.fn().mockResolvedValue({ errorMessages: [], successful: true });
        const push = { broadcastPage, send } as unknown as LunoraPush;
        const job: PushBroadcastJob = { payload: { body: "hi" }, retryIds: ["b"], type: "lunora.push.broadcast" };

        const outcome = await runPushBroadcastJob(push, job);

        expect(broadcastPage).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledWith("b", job.payload);
        expect(outcome.failedIds).toStrictEqual([]);
    });

    it("a retryIds job that still fails throws, so only the failing ids reach the DLQ", async () => {
        expect.hasAssertions();

        const send = vi.fn().mockRejectedValue(new Error("403 VapidPkHashMismatch"));
        const push = { broadcastPage: vi.fn(), send } as unknown as LunoraPush;
        const job: PushBroadcastJob = { payload: { body: "hi" }, retryIds: ["b"], type: "lunora.push.broadcast" };

        await expect(runPushBroadcastJob(push, job)).rejects.toThrow(/retry failed/u);
        expect(send).toHaveBeenCalledTimes(1);
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
