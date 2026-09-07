// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const client = {
    has_opted_in_capturing: vi.fn(() => false),
    init: vi.fn(),
    opt_in_capturing: vi.fn(),
    opt_out_capturing: vi.fn(),
    reset: vi.fn(),
};

vi.mock("posthog-js", () => ({ default: client }));

/**
 * Load `lib/posthog` fresh, with the documented env vars set or absent.
 *
 * The module initializes at import time, so each case needs its own module
 * registry — `vi.resetModules()` before the dynamic import is what gives it one.
 *
 * The unconfigured case *deletes* both variables rather than leaving them
 * alone: `apps/docs/.env` is gitignored but present on any machine set up for
 * analytics, and Vite loads it into `import.meta.env` for the test run too. A
 * merely-absent stub made that case unreachable locally — it initialized with
 * the real token and only passed on a machine that had no `.env`, which is to
 * say on CI.
 */
const loadModule = async (configured: boolean) => {
    vi.stubEnv("VITE_PUBLIC_POSTHOG_PROJECT_TOKEN", configured ? "phc_test" : undefined);
    vi.stubEnv("VITE_PUBLIC_POSTHOG_HOST", configured ? "https://eu.posthog.com" : undefined);

    vi.resetModules();

    return import("@/lib/posthog");
};

describe("posthog consent wiring", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        client.has_opted_in_capturing.mockReturnValue(false);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("initializes opted out of capture and of device storage", async () => {
        expect.assertions(3);

        await loadModule(true);

        expect(client.init).toHaveBeenCalledTimes(1);

        // The consent banner has no answer yet when this runs, so the defaults
        // are what stand in for "rejected" until it does.
        const config = client.init.mock.calls[0][1] as Record<string, unknown>;

        expect(config.opt_out_capturing_by_default).toBe(true);
        expect(config.opt_out_persistence_by_default).toBe(true);
    });

    it("opts in only once consent is granted", async () => {
        expect.assertions(2);

        const { applyMeasurementConsent } = await loadModule(true);

        applyMeasurementConsent(true);

        expect(client.opt_in_capturing).toHaveBeenCalledTimes(1);
        expect(client.opt_out_capturing).not.toHaveBeenCalled();
    });

    it("erases the identifiers the accept path persisted when consent is withdrawn", async () => {
        expect.assertions(2);

        const { applyMeasurementConsent } = await loadModule(true);

        client.has_opted_in_capturing.mockReturnValue(true);
        applyMeasurementConsent(false);

        // Opting out alone stops capture but leaves distinct_id/device_id behind.
        expect(client.reset).toHaveBeenCalledWith(true);
        expect(client.opt_out_capturing).toHaveBeenCalledTimes(1);
    });

    it("does not reset a visitor who never opted in", async () => {
        expect.assertions(2);

        const { applyMeasurementConsent } = await loadModule(true);

        applyMeasurementConsent(false);

        expect(client.reset).not.toHaveBeenCalled();
        expect(client.opt_out_capturing).toHaveBeenCalledTimes(1);
    });

    it("touches nothing when the project is not configured", async () => {
        expect.assertions(3);

        const { applyMeasurementConsent } = await loadModule(false);

        applyMeasurementConsent(true);
        applyMeasurementConsent(false);

        // `opt_in_capturing` on an instance that never loaded is not a no-op —
        // it reaches for the persistence that `init` is what creates.
        expect(client.init).not.toHaveBeenCalled();
        expect(client.opt_in_capturing).not.toHaveBeenCalled();
        expect(client.opt_out_capturing).not.toHaveBeenCalled();
    });
});
