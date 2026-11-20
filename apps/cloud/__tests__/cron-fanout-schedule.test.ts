import { afterEach, describe, expect, it, vi } from "vitest";

import { cronDue } from "../src/fanout/cron";
import { runTenantCrons } from "../src/fanout/tenant-crons";
import { runScheduled } from "../src/sweeps/scheduled";
import type { TargetFleet } from "../src/targets/driver";

vi.mock(import("../src/fanout/tenant-crons"), () => {
    return { runTenantCrons: vi.fn<typeof runTenantCrons>(() => Promise.resolve()) };
});

vi.mock(import("../src/fanout/live"), async (importOriginal) => {
    return { ...(await importOriginal()), readHalted: () => Promise.resolve(new Set<string>()), readLiveDeployments: () => Promise.resolve([]) };
});

vi.mock(import("../src/targets/registry"), async (importOriginal) => {
    const dispatch: NonNullable<TargetFleet["dispatch"]> = () => () => Promise.resolve(new Response(null));

    return { ...(await importOriginal()), registeredFleets: () => [{ dispatch, id: "cloudflare-wfp" } as unknown as TargetFleet] };
});

/**
 * The tenant cron fan-out runs last on the every-minute tick, behind every other
 * sweep, so it can start after the minute it was scheduled for has passed. Its
 * crons are matched against the tick's scheduled minute, not the wall clock, or a
 * slow tick fires the next minute's crons and skips its own.
 */
describe("the tenant cron fan-out's clock", () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.mocked(runTenantCrons).mockClear();
    });

    it("matches crons against the tick's scheduled minute when the tick runs late", async () => {
        expect.hasAssertions();

        const scheduledTime = Date.UTC(2026, 5, 15, 12, 0, 0);

        vi.useFakeTimers({ now: Date.UTC(2026, 5, 15, 12, 1, 5), toFake: ["Date"] });
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        vi.spyOn(console, "log").mockImplementation(() => undefined);

        await runScheduled(
            { cron: "*/1 * * * *", scheduledTime },
            { DB: {} } as never,
            { waitUntil: () => undefined },
            { fetch: () => Promise.resolve(new Response(null)), scheduled: () => Promise.resolve() },
        );

        expect(runTenantCrons).toHaveBeenCalledTimes(1);

        const now = vi.mocked(runTenantCrons).mock.calls[0]?.[0].now ?? new Date(0);

        expect(now.getTime()).toBe(scheduledTime);
        expect([cronDue("0 12 * * *", now), cronDue("1 12 * * *", now)]).toStrictEqual([true, false]);
    });
});
