import { expect, test } from "../fixtures/lunora.js";

/**
 * Scheduler E2E — schedules a job through the `/test/schedule` harness route
 * and waits for the SchedulerDO alarm to dispatch it back into the worker.
 *
 * Notes:
 *   - Durable Object alarms DO fire in `@cloudflare/vite-plugin`'s embedded dev
 *     Miniflare; this spec was skipped for years on the belief that they don't.
 *     What actually swallowed every job was the playground's own
 *     `authorizeShard` gate: server-initiated dispatch re-enters it with a
 *     `null` system identity, so a gate demanding a `userId` answered the DO's
 *     callback with a 403 the app never saw. See `apps/playground/src/server/index.ts`.
 *   - Miniflare emulates `setAlarm` honestly, so a 1-second delay really does
 *     take a second of wall time. This is the *only* spec that sleeps, because
 *     alarm timing is the unit of measure under test.
 *   - A failed dispatch is not retried for 30 s (`RETRY_BASE_DELAY_MS`), so the
 *     poll budget below is sized for the first attempt landing, not a retry.
 */

test.beforeEach(async ({ resetServer }) => {
    await resetServer();
});

test("scheduled cleanup fires within a few seconds and updates the runs log", async ({ user }) => {
    // `user.request` carries the better-auth session cookie set during signup.
    // `now` is a required input on `cleanup:cleanupOldMessages` (the handler must
    // stay deterministic, so the caller stamps wall-clock time). Omitting it makes
    // the dispatch fail input validation and the job never completes.
    const scheduleResponse = await user.request.post(`/test/schedule`, {
        data: { args: { now: Date.now() }, delayMs: 1000, functionPath: "cleanup:cleanupOldMessages" },
    });

    expect(scheduleResponse.ok()).toBe(true);

    const { jobId } = (await scheduleResponse.json()) as { jobId: string };

    expect(jobId).toBeTruthy();

    // Poll the /test/job-status route until the SchedulerDO marks it
    // executed, or we hit the budget.
    const deadline = Date.now() + 15_000;
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
