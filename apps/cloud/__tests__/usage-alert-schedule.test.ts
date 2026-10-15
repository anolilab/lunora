import { afterEach, describe, expect, it, vi } from "vitest";

import { runScheduled } from "../src/sweeps/scheduled";
import { runUsageAlertSweep } from "../src/telemetry/usage-alert-sweep";

vi.mock(import("../src/telemetry/usage-alert-sweep"), () => {
    return { runUsageAlertSweep: vi.fn<typeof runUsageAlertSweep>(() => Promise.resolve({ deliveries: [], evaluatedOrgs: 0, fired: 0, incomplete: [] })) };
});

/**
 * The usage-alert sweep is wired into the control plane's hourly tick, and only
 * that one: a rule nothing evaluates would never fire, and no unit test of the
 * sweep itself would notice. Every other sweep on the tick runs against a
 * database that answers nothing; they fail and are logged, as `runScheduled`
 * isolates each one.
 */
describe("the usage-alert sweep's schedule", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.mocked(runUsageAlertSweep).mockClear();
    });

    const tick = async (cron: string): Promise<void> => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        vi.spyOn(console, "log").mockImplementation(() => undefined);

        await runScheduled(
            { cron, scheduledTime: Date.UTC(2026, 5, 15, 10) },
            { DB: {} } as never,
            { waitUntil: () => undefined },
            { fetch: () => Promise.resolve(new Response(null)), scheduled: () => Promise.resolve() },
        );
    };

    it("runs on the hourly tick", async () => {
        expect.hasAssertions();

        await tick("0 */1 * * *");

        expect(runUsageAlertSweep).toHaveBeenCalledTimes(1);
    });

    it("does not run on the every-minute or six-hourly ticks", async () => {
        expect.hasAssertions();

        await tick("*/1 * * * *");
        await tick("0 */6 * * *");

        expect(runUsageAlertSweep).not.toHaveBeenCalled();
    });
});
