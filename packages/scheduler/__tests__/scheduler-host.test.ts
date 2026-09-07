import { describe, expect, it, vi } from "vitest";

import { createSchedulerHost } from "../src/scheduler-host";

/**
 * The `SchedulerHost` adapter — `@lunora/platform`'s neutral scheduling
 * contract over this package's `createScheduler`.
 *
 * It lives here (not in a host package) because it wraps `SchedulerDO`'s
 * client, and the adapter for a contract belongs with the package that owns
 * the wrapped thing. What is worth pinning is the boundary arithmetic: the
 * contract's `at`/`delayMs` pair collapses to one absolute instant, and the
 * precedence between them is behaviour a host must not get wrong — a job
 * scheduled for "now + 5s" that fires at `at`'s stale value fires at the
 * wrong time with no error anywhere.
 */

/**
 * A `SchedulerDO` namespace double. The DO client calls the stub as
 * `fetch(url, init)` with a JSON string body — not with a `Request` — so the
 * double records `init` and answers with the wire envelope the client expects.
 */
const namespace = () => {
    const sent: Record<string, unknown>[] = [];
    const fetch = vi.fn<(url: string, init?: { body?: string }) => Promise<Response>>(async (_url, init) => {
        const body = init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>);

        sent.push(body);

        return Response.json({ cancelled: true, id: "job-1", scheduledFor: body.scheduledFor ?? 0 });
    });

    return {
        fetch,
        get: () => {
            return { fetch };
        },
        idFromName: (name: string) => `id:${name}`,
        sent,
    };
};

describe("createSchedulerHost", () => {
    it("schedules at the absolute instant when `at` is given, ignoring delayMs", async () => {
        expect.assertions(1);

        const ns = namespace();
        const host = createSchedulerHost({ namespace: ns as never });

        // `at` wins over `delayMs` per the contract. A host that adds them, or
        // prefers the delay, schedules at the wrong time silently.
        await host.schedule("jobs:cleanup", {}, { at: 1_900_000_000_000, delayMs: 60_000 });

        expect(ns.sent[0]?.scheduledFor).toBe(1_900_000_000_000);
    });

    it("resolves delayMs relative to now", async () => {
        expect.assertions(1);

        const before = Date.now();
        const ns = namespace();
        const host = createSchedulerHost({ namespace: ns as never });

        await host.schedule("jobs:cleanup", {}, { delayMs: 30_000 });

        // Within the test's own runtime window — the point is "now + 30s", not
        // an exact clock value.
        expect(Number(ns.sent[0]?.scheduledFor)).toBeGreaterThanOrEqual(before + 30_000);
    });

    it("maps cancel onto the client and returns the bare boolean", async () => {
        expect.assertions(1);

        const host = createSchedulerHost({ namespace: namespace() as never });

        await expect(host.cancel("job-1")).resolves.toBe(true);
    });
});
