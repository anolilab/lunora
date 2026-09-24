import { describe, expect, it, vi } from "vitest";

import type { PushBroadcastJob } from "../src/queue";
import { enqueuePushBroadcast, runPushBroadcastPage } from "../src/queue";
import type { LunoraPush } from "../src/types";

describe("queue-backed fan-out", () => {
    it("does not re-export the old `runPushBroadcastJob` name under any alias", async () => {
        expect.hasAssertions();

        // The page runner stopped throwing on a partial failure and started
        // returning `failedIds` instead. Because the result type only WIDENED,
        // the previously documented consumer
        //
        //     const { nextCursor } = await runPushBroadcastJob(ctx.push, message.body);
        //
        // still compiled, still acked, and silently dropped every transiently
        // failed push. The rename is what makes that stale call site a BUILD
        // error rather than a runtime data loss — so re-adding the old name as a
        // convenience alias would restore the silent break.
        const barrel: Record<string, unknown> = await import("../src/index");

        expect(barrel).not.toHaveProperty("runPushBroadcastJob");
    });

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

        await runPushBroadcastPage(push, job);

        expect(broadcastPage).toHaveBeenCalledWith(job.payload, undefined);
    });

    it("returns the page (continuation included) instead of throwing when some recipients failed", async () => {
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

        const outcome = await runPushBroadcastPage(push, job);

        expect(outcome.nextFilter).toStrictEqual({ after: "wp2_page2" });
        expect(outcome.failedIds).toStrictEqual(["b"]);
    });

    it("a retryIds job redelivers to exactly those ids and never walks a page", async () => {
        expect.hasAssertions();

        const broadcastPage = vi.fn();
        const send = vi.fn().mockResolvedValue({ errorMessages: [], successful: true });
        const push = { broadcastPage, send } as unknown as LunoraPush;
        const job: PushBroadcastJob = { payload: { body: "hi" }, retryIds: ["b"], type: "lunora.push.broadcast" };

        const outcome = await runPushBroadcastPage(push, job);

        expect(broadcastPage).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledWith("b", job.payload);
        expect(outcome.failedIds).toStrictEqual([]);
    });

    it("a retryIds job that still fails throws, so only the failing ids reach the DLQ", async () => {
        expect.hasAssertions();

        const send = vi.fn().mockRejectedValue(new Error("403 VapidPkHashMismatch"));
        const push = { broadcastPage: vi.fn(), send } as unknown as LunoraPush;
        const job: PushBroadcastJob = { payload: { body: "hi" }, retryIds: ["b"], type: "lunora.push.broadcast" };

        await expect(runPushBroadcastPage(push, job)).rejects.toThrow(/retry failed/u);
        expect(send).toHaveBeenCalledTimes(1);
    });

    it("a retryIds job that partly recovered does NOT throw, so the recovered ids are never re-sent", async () => {
        expect.hasAssertions();

        // Throwing on ANY failure re-runs the WHOLE message, and the message
        // carries every id — so `a` and `b`, which just succeeded, get a second
        // (and third, and fourth) push on every queue redelivery. Progress must
        // be kept: return the still-failing ids so the caller enqueues a
        // narrower retry, exactly as a partially-failed PAGE already does.
        const send = vi.fn(async (id: string) => {
            if (id === "c") {
                throw new Error("403 VapidPkHashMismatch");
            }

            return { errorMessages: [], successful: true };
        });
        const push = { broadcastPage: vi.fn(), send } as unknown as LunoraPush;
        const job: PushBroadcastJob = { payload: { body: "hi" }, retryIds: ["a", "b", "c"], type: "lunora.push.broadcast" };

        const outcome = await runPushBroadcastPage(push, job);

        expect(outcome.failedIds).toStrictEqual(["c"]);
        expect(outcome.result).toMatchObject({ failed: 1, sent: 2, total: 3 });
    });

    it("counts a gone receipt on the retry path as pruned, not as a failure to redeliver", async () => {
        expect.hasAssertions();

        // `push.send` prunes the row and then RETURNS the failed receipt, so a gone
        // device landed back in `failedIds`. The caller enqueues a narrower retry,
        // whose `push.send` now throws `no registered subscription` for an id that
        // no longer exists — `sent === 0`, so the runner throws, the queue backs off
        // and eventually dead-letters a device that simply unsubscribed. The
        // docblock promises the opposite: gone ids never appear in `failedIds`.
        const send = vi.fn().mockResolvedValue({ errorMessages: ["Subscription gone (HTTP 410) — remove this subscription"], successful: false });
        const push = { broadcastPage: vi.fn(), send } as unknown as LunoraPush;
        const job: PushBroadcastJob = { payload: { body: "hi" }, retryIds: ["wp2_dead"], type: "lunora.push.broadcast" };

        const outcome = await runPushBroadcastPage(push, job);

        expect(outcome.failedIds).toStrictEqual([]);
        expect(outcome.result).toMatchObject({ failed: 0, pruned: 1, sent: 0, total: 1 });
    });

    it("reads a gone receipt with the kind its id encodes, so FCM prose prunes and web-push prose does not", async () => {
        expect.hasAssertions();

        // The FCM-only patterns must not be applied to a web-push failure whose
        // body happens to echo them — the same provider-scoping `isGoneError` takes
        // a `kind` for. A receipt carries no kind, but the subscription id does.
        const fcmSend = vi.fn().mockResolvedValue({ errorMessages: ["[@visulima/notification] [fcm] Requested entity was not found."], successful: false });
        const webPushSend = vi.fn().mockResolvedValue({ errorMessages: ["HTTP 403: sender not registered for this endpoint"], successful: false });

        await expect(
            runPushBroadcastPage({ broadcastPage: vi.fn(), send: fcmSend } as unknown as LunoraPush, {
                payload: { body: "hi" },
                retryIds: ["fcm2_dead"],
                type: "lunora.push.broadcast",
            }),
        ).resolves.toMatchObject({ failedIds: [], result: { pruned: 1 } });

        await expect(
            runPushBroadcastPage({ broadcastPage: vi.fn(), send: webPushSend } as unknown as LunoraPush, {
                payload: { body: "hi" },
                retryIds: ["wp2_live"],
                type: "lunora.push.broadcast",
            }),
        ).rejects.toThrow(/retry failed/u);
    });

    it("treats an id that no longer exists as already pruned, not as a permanent failure", async () => {
        expect.hasAssertions();

        // A device unregistered between the page and its retry cannot be
        // redelivered to, ever. Counting it as a failure meant the message threw on
        // every redelivery until the queue dead-lettered it.
        const send = vi.fn().mockRejectedValue(new Error('@lunora/notify: no registered subscription with id "wp2_dead"'));
        const push = { broadcastPage: vi.fn(), send } as unknown as LunoraPush;
        const job: PushBroadcastJob = { payload: { body: "hi" }, retryIds: ["wp2_dead"], type: "lunora.push.broadcast" };

        await expect(runPushBroadcastPage(push, job)).resolves.toMatchObject({ failedIds: [], result: { failed: 0, pruned: 1 } });
    });

    it("spends `filter.limit` as an OVERALL cap across messages, not once per message", async () => {
        expect.hasAssertions();

        // `limit` documents itself as a cap on the total audience reached. On the
        // queue path the caller re-enqueues the continuation, so the REMAINING
        // budget has to travel with it — forwarding `filter` verbatim let every
        // message reach up to `limit` more devices and walk the whole audience.
        const broadcastPage = vi.fn().mockResolvedValue({ nextCursor: "wp2_page2", result: { failed: 0, outcomes: [], pruned: 0, sent: 4, total: 4 } });
        const push = { broadcastPage } as unknown as LunoraPush;
        const job: PushBroadcastJob = { filter: { limit: 10, userId: "u1" }, payload: { body: "hi" }, type: "lunora.push.broadcast" };

        const outcome = await runPushBroadcastPage(push, job);

        expect(outcome.nextFilter).toStrictEqual({ after: "wp2_page2", limit: 6, userId: "u1" });
    });

    it("stops the walk once `filter.limit` is spent, even with pages remaining", async () => {
        expect.hasAssertions();

        const broadcastPage = vi.fn().mockResolvedValue({ nextCursor: "wp2_page2", result: { failed: 0, outcomes: [], pruned: 0, sent: 4, total: 4 } });
        const push = { broadcastPage } as unknown as LunoraPush;
        const job: PushBroadcastJob = { filter: { limit: 4 }, payload: { body: "hi" }, type: "lunora.push.broadcast" };

        const outcome = await runPushBroadcastPage(push, job);

        expect(outcome.nextFilter).toBeUndefined();
    });

    it("does NOT throw when the whole page was pruned (a successful prune, not a failure)", async () => {
        expect.hasAssertions();

        // Every device on this page had unsubscribed: `sent:0`, `failed:0`, `pruned:N`.
        // That is a SUCCESSFUL prune, not a failure, so throwing on it would
        // spuriously retry and pressure the DLQ — it must resolve (ack).
        const broadcastPage = vi.fn().mockResolvedValue({ nextCursor: undefined, result: { failed: 0, outcomes: [], pruned: 3, sent: 0, total: 3 } });
        const push = { broadcastPage } as unknown as LunoraPush;
        const job: PushBroadcastJob = { payload: { body: "hi" }, type: "lunora.push.broadcast" };

        await expect(runPushBroadcastPage(push, job)).resolves.toMatchObject({ result: { pruned: 3, sent: 0 } });
    });

    it("resolves for an empty page — nothing to retry", async () => {
        expect.hasAssertions();

        const broadcastPage = vi.fn().mockResolvedValue({ nextCursor: undefined, result: { failed: 0, outcomes: [], pruned: 0, sent: 0, total: 0 } });
        const push = { broadcastPage } as unknown as LunoraPush;
        const job: PushBroadcastJob = { payload: { body: "hi" }, type: "lunora.push.broadcast" };

        await expect(runPushBroadcastPage(push, job)).resolves.toMatchObject({ result: { total: 0 } });
    });

    it("surfaces the continuation filter so the caller can enqueue the next page", async () => {
        expect.hasAssertions();

        const broadcastPage = vi
            .fn()
            .mockResolvedValue({ nextCursor: "wp2_deadbeefdeadbeef", result: { failed: 0, outcomes: [], pruned: 0, sent: 5, total: 5 } });
        const push = { broadcastPage } as unknown as LunoraPush;
        const job: PushBroadcastJob = { payload: { body: "hi" }, type: "lunora.push.broadcast" };

        const outcome = await runPushBroadcastPage(push, job);

        expect(outcome.nextFilter).toStrictEqual({ after: "wp2_deadbeefdeadbeef" });
    });

    it("a job carrying a cursor resumes broadcastPage with that cursor as `filter.after`", async () => {
        expect.hasAssertions();

        const broadcastPage = vi.fn().mockResolvedValue({ nextCursor: undefined, result: { failed: 0, outcomes: [], pruned: 0, sent: 1, total: 1 } });
        const push = { broadcastPage } as unknown as LunoraPush;
        const job: PushBroadcastJob = { filter: { after: "wp2_1111111111111111", userId: "u1" }, payload: { body: "hi" }, type: "lunora.push.broadcast" };

        await runPushBroadcastPage(push, job);

        expect(broadcastPage).toHaveBeenCalledWith(job.payload, { after: "wp2_1111111111111111", userId: "u1" });
    });
});
