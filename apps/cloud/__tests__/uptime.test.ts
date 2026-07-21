import { describe, expect, it, vi } from "vitest";

import type { ControlPlaneDb } from "../src/deploy/sweeps";
import { nextConsecutiveFailures, probeDeployment, summarizeUptime } from "../src/uptime/probe";
import type { UptimeProbe } from "../src/uptime/probe";
import { runUptimeSweep } from "../src/uptime/sweep";

/** A fake ControlPlaneDb answering findMany per-table, mirroring sweeps.test.ts. */
const fakeDb = (pages: Record<string, unknown[]>, spies: Partial<ControlPlaneDb> = {}): ControlPlaneDb => ({
    findMany: (table) => Promise.resolve({ page: pages[table] ?? [] }),
    insert: () => Promise.resolve("alert_id"),
    patch: () => Promise.resolve(undefined),
    ...spies,
});

/** A clock that advances 5ms per read, so probe latency is a deterministic 5. */
const stepClock = (): (() => number) => {
    let t = 0;

    return () => (t += 5);
};

describe(probeDeployment, () => {
    it("is up on a sub-500 status and records the code + latency", async () => {
        const fetch = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof globalThis.fetch;

        const probe = await probeDeployment({ clock: stepClock(), fetch, url: "https://a.example" });

        expect(probe).toStrictEqual({ latencyMs: 5, ok: true, statusCode: 204 });
    });

    it("is down on a 5xx status", async () => {
        const fetch = vi.fn(async () => new Response(null, { status: 503 })) as unknown as typeof globalThis.fetch;

        const probe = await probeDeployment({ clock: stepClock(), fetch, url: "https://a.example" });

        expect(probe).toStrictEqual({ latencyMs: 5, ok: false, statusCode: 503 });
    });

    it("is down (never throws) when the fetch rejects, carrying the message", async () => {
        const fetch = vi.fn(async () => {
            throw new Error("connection refused");
        }) as unknown as typeof globalThis.fetch;

        const probe = await probeDeployment({ clock: stepClock(), fetch, url: "https://a.example" });

        expect(probe).toStrictEqual({ error: "connection refused", latencyMs: 5, ok: false });
    });
});

describe(nextConsecutiveFailures, () => {
    it("resets to 0 on a success and increments on a failure", () => {
        expect(nextConsecutiveFailures(0, false)).toBe(1);
        expect(nextConsecutiveFailures(3, false)).toBe(4);
        expect(nextConsecutiveFailures(3, true)).toBe(0);
    });
});

describe(summarizeUptime, () => {
    it("treats no samples as up at 100%", () => {
        expect(summarizeUptime([])).toStrictEqual({ ok: true, sampleCount: 0, upFraction: 1 });
    });

    it("computes the up-fraction, current status, and mean successful latency", () => {
        // newest-first: current status is the first sample.
        const summary = summarizeUptime([{ latencyMs: 10, ok: true }, { latencyMs: 20, ok: true }, { ok: false }, { latencyMs: 30, ok: true }]);

        expect(summary.ok).toBe(true);
        expect(summary.sampleCount).toBe(4);
        expect(summary.upFraction).toBe(0.75);
        expect(summary.avgLatencyMs).toBe(20); // (10 + 20 + 30) / 3
    });
});

/** A one-deployment, one-uptime-rule org, with injected probe results. */
const sweepFixture = (probe: UptimeProbe, overrides: { rules?: unknown[]; state?: unknown[] } = {}) => {
    const insert = vi.fn((table: string) => Promise.resolve(`${table}_id`));
    const patch = vi.fn(() => Promise.resolve(undefined));
    const database = fakeDb(
        {
            alertRules: overrides.rules ?? [
                {
                    _id: "rule1",
                    channel: "webhook",
                    destination: "https://hook.example",
                    enabled: true,
                    name: "prod down",
                    organizationId: "org1",
                    target: "uptime",
                    threshold: 1,
                },
            ],
            deployments: [{ _id: "dep1", organizationId: "org1", status: "live", url: "https://a.example" }],
            uptimeState: overrides.state ?? [],
        },
        { insert, patch },
    );

    return { database, insert, patch, run: () => runUptimeSweep(database, { fetch: globalThis.fetch, now: 1000, probe: () => Promise.resolve(probe) }) };
};

describe(runUptimeSweep, () => {
    it("records every probe and inserts state for a first-seen deployment", async () => {
        const { insert, run } = sweepFixture({ latencyMs: 8, ok: true, statusCode: 200 });

        const result = await run();

        expect(result.probed).toBe(1);
        expect(insert).toHaveBeenCalledWith("uptimeChecks", expect.objectContaining({ deploymentId: "dep1", latencyMs: 8, ok: true, statusCode: 200 }));
        expect(insert).toHaveBeenCalledWith("uptimeState", expect.objectContaining({ consecutiveFailures: 0, deploymentId: "dep1", lastOk: true }));
        expect(result.deliveries).toStrictEqual([]);
    });

    it("fires an uptime alert the first time failures cross the rule threshold", async () => {
        const { insert, run } = sweepFixture({ error: "timeout", latencyMs: 10, ok: false });

        const result = await run();

        // consecutiveFailures 0 → 1 crosses threshold 1.
        expect(insert).toHaveBeenCalledWith("alerts", expect.objectContaining({ status: "firing", target: "uptime", hash: "dep1", channel: "webhook" }));
        expect(result.deliveries).toHaveLength(1);
        expect(result.deliveries[0]?.subject).toContain("is down");
    });

    it("does not re-fire while a deployment stays down past the crossing", async () => {
        // Already at 1 consecutive failure; another failure → 2, which does not re-cross threshold 1.
        const { insert, run } = sweepFixture(
            { latencyMs: 10, ok: false, statusCode: 502 },
            { state: [{ _id: "state1", consecutiveFailures: 1, deploymentId: "dep1", lastOk: false }] },
        );

        const result = await run();

        expect(result.deliveries).toStrictEqual([]);
        expect(insert).not.toHaveBeenCalledWith("alerts", expect.anything());
    });

    it("advances existing state via patch rather than insert", async () => {
        const { insert, patch, run } = sweepFixture(
            { latencyMs: 10, ok: true, statusCode: 200 },
            { state: [{ _id: "state1", consecutiveFailures: 2, deploymentId: "dep1", lastOk: false }] },
        );

        await run();

        expect(patch).toHaveBeenCalledWith("state1", expect.objectContaining({ consecutiveFailures: 0, lastOk: true }), "uptimeState");
        expect(insert).not.toHaveBeenCalledWith("uptimeState", expect.anything());
    });

    it("skips deployments without a URL and never fires for a disabled rule", async () => {
        const database = fakeDb({
            alertRules: [
                {
                    _id: "r1",
                    channel: "webhook",
                    destination: "https://hook.example",
                    enabled: false,
                    name: "off",
                    organizationId: "org1",
                    target: "uptime",
                    threshold: 1,
                },
            ],
            deployments: [{ _id: "dep1", organizationId: "org1", status: "live" }],
            uptimeState: [],
        });

        const result = await runUptimeSweep(database, { fetch: globalThis.fetch, now: 1000, probe: () => Promise.resolve({ latencyMs: 1, ok: false }) });

        expect(result.probed).toBe(0);
        expect(result.deliveries).toStrictEqual([]);
    });
});
