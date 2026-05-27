import { expect, test } from "../fixtures/cirrus.js";

/**
 * Scheduler E2E — schedules a job through `ctx.scheduler.runAfter` and waits
 * for the SchedulerDO alarm to fire it.
 *
 * Notes:
 *   - Miniflare emulates DO `setAlarm` honestly, so 1-second delays really
 *     do take 1 second of wall time. We tolerate up to 5 seconds.
 *   - This is the *only* spec that uses a wall-clock sleep, because cron
 *     timing is the unit of measure under test.
 */

test.beforeEach(async ({ resetServer }) => {
    await resetServer();
});

test("scheduled cleanup fires within a few seconds and updates the runs log", async ({ user }) => {
    // `user.request` carries the better-auth session cookie set during signup.
    const scheduleResponse = await user.request.post(`/test/schedule`, {
        data: { afterMs: 1000, function: "cleanup:cleanupOldMessages" },
    });

    if (scheduleResponse.status() === 404) {
        test.skip(true, "playground has no /test/schedule helper; scheduler test needs harness route");

        return;
    }

    expect(scheduleResponse.ok()).toBe(true);

    const { jobId } = (await scheduleResponse.json()) as { jobId: string };

    expect(jobId).toBeTruthy();

    // Poll the /test/job-status route until the SchedulerDO marks it
    // executed, or we hit the 5s budget.
    const deadline = Date.now() + 5000;
    let status: string | null = null;

    while (Date.now() < deadline) {
        const statusResponse = await user.request.get(`/test/job-status?id=${encodeURIComponent(jobId)}`);

        if (statusResponse.ok()) {
            const body = (await statusResponse.json()) as { status?: string };

            status = body.status ?? null;

            if (status === "executed") {
                break;
            }
        }

        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    expect(status).toBe("executed");
});
