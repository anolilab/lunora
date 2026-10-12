import { describe, expect, it, vi } from "vitest";

import { createPlanResolver, LOOKUP_FAILURE_BACKOFF_MS } from "../src/plans/plan-resolver";
import { answer, down, HOUR, spiedStore, T0 } from "./_helpers/plan-fixtures";

describe("plan lookup failure backoff", () => {
    it("skips the control plane for the backoff window after a failed lookup, when a store is bound", async () => {
        const clock = { now: T0 };
        const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(down);
        const resolve = createPlanResolver({
            controlPlaneToken: "t",
            controlPlaneUrl: "https://cp",
            fetch,
            now: () => clock.now,
            planStore: spiedStore(),
        });

        await resolve("acme-app");
        clock.now += LOOKUP_FAILURE_BACKOFF_MS - 1;
        await resolve("acme-app");

        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("answers a backed-off request from the stored plan, not from the control plane", async () => {
        const clock = { now: T0 };
        const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(down);
        const resolve = createPlanResolver({
            controlPlaneToken: "t",
            controlPlaneUrl: "https://cp",
            fetch,
            now: () => clock.now,
            planStore: spiedStore({ "acme-app": { plan: "pro", protected: true, verifiedAt: T0 - HOUR } }),
        });

        await resolve("acme-app");
        clock.now += LOOKUP_FAILURE_BACKOFF_MS - 1;
        const facts = await resolve("acme-app");

        expect(fetch).toHaveBeenCalledTimes(1);
        expect(facts).toStrictEqual({ plan: "pro", protected: true });
    });

    it("looks up again once the backoff window has passed", async () => {
        const clock = { now: T0 };
        const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(down);
        const resolve = createPlanResolver({
            controlPlaneToken: "t",
            controlPlaneUrl: "https://cp",
            fetch,
            now: () => clock.now,
            planStore: spiedStore(),
        });

        await resolve("acme-app");
        clock.now += LOOKUP_FAILURE_BACKOFF_MS + 1;
        await resolve("acme-app");

        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("clears the backoff on a successful lookup, so the next request asks the control plane straight away", async () => {
        const clock = { now: T0 };
        const fetch = vi.fn<typeof globalThis.fetch>();
        let finishSlow!: (response: Response) => void;
        const slowLookup = new Promise<Response>((resolve) => {
            finishSlow = resolve;
        });

        // slow-app's lookup is in flight when other-app fails, which opens the window at the same instant.
        fetch
            .mockImplementationOnce(() => slowLookup)
            .mockImplementationOnce(down)
            .mockImplementation(() => answer({ plan: "free" }));
        const resolve = createPlanResolver({
            controlPlaneToken: "t",
            controlPlaneUrl: "https://cp",
            fetch,
            now: () => clock.now,
            planStore: spiedStore(),
        });

        const pending = resolve("slow-app");
        await resolve("other-app");
        finishSlow(Response.json({ plan: "pro" }));
        await pending;

        await expect(resolve("third-app")).resolves.toStrictEqual({ plan: "free" });
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it("applies a failure to every script, not only the one that failed, and answers the other from its stored plan", async () => {
        const clock = { now: T0 };
        const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(down);
        const resolve = createPlanResolver({
            controlPlaneToken: "t",
            controlPlaneUrl: "https://cp",
            fetch,
            now: () => clock.now,
            planStore: spiedStore({ "other-app": { plan: "enterprise", verifiedAt: T0 - HOUR } }),
        });

        await resolve("acme-app");
        clock.now += 1;
        const facts = await resolve("other-app");

        expect(fetch).toHaveBeenCalledTimes(1);
        expect(facts).toStrictEqual({ plan: "enterprise" });
    });

    it("does not back off when no store is bound, so a failed lookup is retried on the next request", async () => {
        const clock = { now: T0 };
        const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(down);
        const resolve = createPlanResolver({
            controlPlaneToken: "t",
            controlPlaneUrl: "https://cp",
            fetch,
            now: () => clock.now,
        });

        await resolve("acme-app");
        await resolve("acme-app");

        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("bounds the lookup with the timeout only when a store is bound", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(down);
        const resolve = createPlanResolver({ controlPlaneToken: "t", controlPlaneUrl: "https://cp", fetch, now: () => T0 });

        await resolve("acme-app");

        expect(fetch.mock.calls[0]?.[1]?.signal).toBeUndefined();
    });
});
