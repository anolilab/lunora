import { describe, expect, it } from "vitest";

import { createRivetActorDouble } from "../src/conformance/rivet-actor-double";
import { createRivetSchedulerHost, RIVET_CRON_ACTION, RIVET_SCHEDULER_ACTION } from "../src/rivet-scheduler-host";

/**
 * The shared TCK covers the contract-level scheduler invariants. These are the
 * Rivet-specific ones: that the host arms Rivet's own schedules rather than a
 * timer of its own, that it registers real crons (the optional member
 * Cloudflare cannot offer), and that the retry ladder Rivet deliberately does
 * not provide is implemented here.
 */
describe("rivet scheduler host", () => {
    it("arms a Rivet schedule pointed at the dispatch action", async () => {
        expect.assertions(3);

        const actor = createRivetActorDouble();

        try {
            const { scheduler } = createRivetSchedulerHost(actor);
            const job = await scheduler.schedule("tasks/remind", { user: "ada" }, { delayMs: 10_000 });

            const armed = await actor.schedule.list();

            expect(armed).toHaveLength(1);
            expect(armed[0]?.action).toBe(RIVET_SCHEDULER_ACTION);
            // The Rivet schedule carries only the job id; the payload lives in
            // this host's table, because a Rivet schedule invokes an action on
            // the actor rather than delivering an arbitrary function call.
            expect(armed[0]?.args).toStrictEqual([job.id]);
        } finally {
            actor.cleanup();
        }
    });

    it("registers a runtime cron on Rivet", async () => {
        expect.assertions(3);

        const actor = createRivetActorDouble();

        try {
            const { scheduler } = createRivetSchedulerHost(actor);

            expect(scheduler.cron).toBeDefined();

            await scheduler.cron?.("0 9 * * *", "reports/daily", { report: "sales" });

            const job = actor.crons.get("lunora:reports/daily");

            expect(job?.expression).toBe("0 9 * * *");
            expect(job?.action).toBe(RIVET_CRON_ACTION);
        } finally {
            actor.cleanup();
        }
    });

    it("retries a failed delivery with backoff before parking it", async () => {
        expect.assertions(4);

        const actor = createRivetActorDouble();

        try {
            let attempts = 0;
            const { deliverScheduledJob, scheduler } = createRivetSchedulerHost(actor, {
                onDispatch: () => {
                    attempts += 1;
                    throw new Error("delivery failed");
                },
            });

            const job = await scheduler.schedule("tasks/remind", {}, { delayMs: 0, retry: { maxAttempts: 2 } });

            await deliverScheduledJob(job.id);

            // Budget not spent: still pending, with the attempt counted, and
            // re-armed rather than dropped.
            const afterFirst = await scheduler.list?.();

            expect(afterFirst?.find((entry) => entry.id === job.id)?.attempts).toBe(1);

            await deliverScheduledJob(job.id);

            const stillPending = await scheduler.list?.();
            const parked = await scheduler.deadLetter?.list();

            expect(attempts).toBe(2);
            expect(stillPending?.some((entry) => entry.id === job.id)).toBe(false);
            // Parked, not dropped: a dropped job is indistinguishable from a
            // delivered one to every caller.
            expect(parked?.some((entry) => entry.id === job.id)).toBe(true);
        } finally {
            actor.cleanup();
        }
    });

    it("cancels the Rivet schedule alongside the job row", async () => {
        expect.assertions(2);

        const actor = createRivetActorDouble();

        try {
            const { scheduler } = createRivetSchedulerHost(actor);
            const job = await scheduler.schedule("tasks/remind", {}, { delayMs: 10_000 });

            await expect(scheduler.cancel(job.id)).resolves.toBe(true);

            // A cancelled job that left its Rivet schedule armed would wake the
            // actor for a job that no longer exists — on every cancelled job,
            // forever.
            await expect(actor.schedule.list()).resolves.toStrictEqual([]);
        } finally {
            actor.cleanup();
        }
    });

    it("dispatches a cron tick with its inline payload", async () => {
        expect.assertions(2);

        const actor = createRivetActorDouble();

        try {
            const seen: { args: Record<string, unknown>; path: string }[] = [];
            const { deliverCronTick } = createRivetSchedulerHost(actor, {
                onDispatch: (path, args) => {
                    seen.push({ args, path });
                },
            });

            await deliverCronTick("reports/daily", { report: "sales" });

            expect(seen).toHaveLength(1);
            // A recurring job is not consumed by firing, so there is no job row
            // to look up — the tick carries its own payload.
            expect(seen[0]).toStrictEqual({ args: { report: "sales" }, path: "reports/daily" });
        } finally {
            actor.cleanup();
        }
    });
});
