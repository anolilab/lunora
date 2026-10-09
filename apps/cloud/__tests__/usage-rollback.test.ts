import { describe, expect, it } from "vitest";

import type { UsageAttribution, UsageRecord, UsageRollbackPorts } from "../src/metering/rollback";
import { BOOTSTRAP_WINDOW_MS, HOURLY_ANALYTICS_LAG_MS, MAX_HOURLY_CATCHUP_MS, MAX_LOOKBACK_MS, runUsageRollback, splitByMonth } from "../src/metering/rollback";
import type { UsageWindow } from "../src/targets/driver";

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

const attribution = (org: string, deployment: string): UsageAttribution => {
    return { deploymentId: deployment, organizationId: org };
};

const ports = (overrides: Partial<UsageRollbackPorts>): UsageRollbackPorts => {
    return {
        cadence: "continuous",
        getCheckpoint: () => Promise.resolve(undefined),
        now: NOW,
        read: () => Promise.resolve([]),
        record: () => Promise.resolve(),
        resolveResource: () => undefined,
        setCheckpoint: () => Promise.resolve(),
        ...overrides,
    };
};

describe(runUsageRollback, () => {
    it("reads from the bootstrap window on first run and advances the checkpoint", async () => {
        const windows: UsageWindow[] = [];
        let checkpoint: number | undefined;

        const result = await runUsageRollback(
            ports({
                read: (window) => {
                    windows.push(window);

                    return Promise.resolve([{ meters: { requests: 5 }, resourceRef: "s-v1" }]);
                },
                resolveResource: () => attribution("org_1", "dep_1"),
                setCheckpoint: (ms) => {
                    checkpoint = ms;

                    return Promise.resolve();
                },
            }),
        );

        expect(windows).toStrictEqual([{ sinceMs: NOW - BOOTSTRAP_WINDOW_MS, untilMs: NOW }]);
        expect(checkpoint).toBe(NOW);
        expect(result).toStrictEqual({ attributed: 1, failed: 0, recorded: { requests: 5 }, skipped: 0, unattributed: 0 });
    });

    it("delta-reads from the stored checkpoint (no double count across runs)", async () => {
        const windows: UsageWindow[] = [];

        await runUsageRollback(
            ports({
                getCheckpoint: () => Promise.resolve(NOW - 30_000),
                read: (window) => {
                    windows.push(window);

                    return Promise.resolve([]);
                },
            }),
        );

        expect(windows).toStrictEqual([{ sinceMs: NOW - 30_000, untilMs: NOW }]);
    });

    it("records one ledger row per attributed resource and non-zero meter", async () => {
        const recorded: UsageRecord[] = [];

        const result = await runUsageRollback(
            ports({
                read: () =>
                    Promise.resolve([
                        { meters: { d1RowsRead: 900, d1RowsWritten: 0, doRowsWritten: 40 }, resourceRef: "a" },
                        { meters: { requests: 3 }, resourceRef: "b" },
                    ]),
                record: (record) => {
                    recorded.push(record);

                    return Promise.resolve();
                },
                resolveResource: (resourceRef) => (resourceRef === "a" ? attribution("org_a", "dep_a") : attribution("org_b", "dep_b")),
            }),
        );

        const period = Date.UTC(2023, 10, 1);
        // Every row carries the window it was read for: when the usage happened.
        const window = { sinceMs: NOW - BOOTSTRAP_WINDOW_MS, untilMs: NOW };

        // A zero meter writes nothing; every other meter is its own row.
        expect(recorded).toStrictEqual([
            { attribution: attribution("org_a", "dep_a"), meter: "d1RowsRead", periodStart: period, quantity: 900, window },
            { attribution: attribution("org_a", "dep_a"), meter: "doRowsWritten", periodStart: period, quantity: 40, window },
            { attribution: attribution("org_b", "dep_b"), meter: "requests", periodStart: period, quantity: 3, window },
        ]);
        expect(result).toStrictEqual({ attributed: 2, failed: 0, recorded: { d1RowsRead: 900, doRowsWritten: 40, requests: 3 }, skipped: 0, unattributed: 0 });
    });

    it("skips resources with no matching deployment, keeping their volume, and ignores zero-count rows", async () => {
        const result = await runUsageRollback(
            ports({
                read: () =>
                    Promise.resolve([
                        { meters: { doRowsRead: 7, doRowsWritten: 2 }, resourceRef: "namespace:abc" },
                        { meters: { requests: 0 }, resourceRef: "idle-v1" },
                    ]),
                resolveResource: () => undefined,
            }),
        );

        expect(result).toStrictEqual({ attributed: 0, failed: 0, recorded: {}, skipped: 1, unattributed: 9 });
    });

    it("drops a failed ledger write but still advances the checkpoint (under-count, never double-bill)", async () => {
        let checkpoint: number | undefined;

        const result = await runUsageRollback(
            ports({
                read: () =>
                    Promise.resolve([
                        { meters: { requests: 4 }, resourceRef: "ok-v1" },
                        { meters: { requests: 7 }, resourceRef: "boom-v1" },
                    ]),
                record: ({ attribution: a }) => (a.organizationId === "org_boom" ? Promise.reject(new Error("d1 write failed")) : Promise.resolve()),
                resolveResource: (resourceRef) => (resourceRef === "ok-v1" ? attribution("org_ok", "dep_ok") : attribution("org_boom", "dep_boom")),
                setCheckpoint: (ms) => {
                    checkpoint = ms;

                    return Promise.resolve();
                },
            }),
        );

        expect(result).toStrictEqual({ attributed: 1, failed: 1, recorded: { requests: 4 }, skipped: 0, unattributed: 0 });
        // Checkpoint advances despite the failure — the dropped count is lost, not retried.
        expect(checkpoint).toBe(NOW);
    });

    it("records nothing when the checkpoint write fails, so its retry cannot record the window twice", async () => {
        const recorded: UsageRecord[] = [];
        let checkpoint: number | undefined;
        let failCheckpoint = true;
        const run = async (): Promise<unknown> =>
            runUsageRollback(
                ports({
                    getCheckpoint: () => Promise.resolve(checkpoint),
                    read: () => Promise.resolve([{ meters: { requests: 5 }, resourceRef: "ok-v1" }]),
                    record: (record) => {
                        recorded.push(record);

                        return Promise.resolve();
                    },
                    resolveResource: () => attribution("org_ok", "dep_ok"),
                    setCheckpoint: (ms) => {
                        if (failCheckpoint) {
                            return Promise.reject(new Error("d1 write failed"));
                        }

                        checkpoint = ms;

                        return Promise.resolve();
                    },
                }),
            );

        await expect(run()).rejects.toThrow("d1 write failed");
        expect(recorded).toStrictEqual([]);

        failCheckpoint = false;
        await run();

        expect(recorded.map((record) => record.quantity)).toStrictEqual([5]);
    });

    it("propagates a read failure without advancing the checkpoint", async () => {
        let advanced = false;

        await expect(
            runUsageRollback(
                ports({
                    read: () => Promise.reject(new Error("analytics engine 503")),
                    setCheckpoint: () => {
                        advanced = true;

                        return Promise.resolve();
                    },
                }),
            ),
        ).rejects.toThrow("analytics engine 503");
        expect(advanced).toBe(false);
    });
});

describe("hourly sources", () => {
    // 10:20 UTC: the last hour that closed at least the lag ago ends at 10:00.
    const now = Date.UTC(2026, 5, 10, 10, 20);
    const closed = Date.UTC(2026, 5, 10, 10, 0);

    it("reads only closed hours: the bootstrap is the last hour that ended at least the lag ago", async () => {
        const windows: UsageWindow[] = [];

        await runUsageRollback(
            ports({
                cadence: "hourly",
                now,
                read: (window) => {
                    windows.push(window);

                    return Promise.resolve([]);
                },
            }),
        );

        expect(windows).toStrictEqual([{ sinceMs: closed - HOUR, untilMs: closed }]);
    });

    it("leaves an hour that has not been closed for the lag yet to the next run", async () => {
        const windows: UsageWindow[] = [];
        let advanced = false;

        // 10:10 — the 9:00–10:00 bucket ended only ten minutes ago, inside the lag.
        const early = Date.UTC(2026, 5, 10, 10, 10);

        expect(HOURLY_ANALYTICS_LAG_MS).toBeGreaterThan(10 * 60 * 1000);

        const result = await runUsageRollback(
            ports({
                cadence: "hourly",
                getCheckpoint: () => Promise.resolve(Date.UTC(2026, 5, 10, 9, 0)),
                now: early,
                read: (window) => {
                    windows.push(window);

                    return Promise.resolve([]);
                },
                setCheckpoint: () => {
                    advanced = true;

                    return Promise.resolve();
                },
            }),
        );

        expect(windows).toStrictEqual([]);
        expect(advanced).toBe(false);
        expect(result.attributed).toBe(0);
    });

    it("never asks for an hour older than Cloudflare keeps: it starts at the oldest kept hour and reports the gap", async () => {
        const windows: UsageWindow[] = [];
        const stale = closed - 60 * 24 * HOUR;
        const earliest = Math.ceil((now - MAX_LOOKBACK_MS) / HOUR) * HOUR;

        const result = await runUsageRollback(
            ports({
                cadence: "hourly",
                getCheckpoint: () => Promise.resolve(stale),
                now,
                read: (window) => {
                    windows.push(window);

                    return Promise.resolve([]);
                },
            }),
        );

        expect(windows).toStrictEqual([{ sinceMs: earliest, untilMs: earliest + MAX_HOURLY_CATCHUP_MS }]);
        expect(result.gap).toStrictEqual({ sinceMs: stale, untilMs: earliest });
    });

    it("catches a backlog up at most a day per run", async () => {
        const windows: UsageWindow[] = [];
        const since = closed - 3 * 24 * HOUR;

        await runUsageRollback(
            ports({
                cadence: "hourly",
                getCheckpoint: () => Promise.resolve(since),
                now,
                read: (window) => {
                    windows.push(window);

                    return Promise.resolve([]);
                },
            }),
        );

        expect(windows).toStrictEqual([{ sinceMs: since, untilMs: since + MAX_HOURLY_CATCHUP_MS }]);
    });
});

describe("month attribution", () => {
    it("bills each part of a window that crosses a month boundary to its own month, checkpointing after each part", async () => {
        const july = Date.UTC(2026, 6, 1);
        const june = Date.UTC(2026, 5, 1);
        const since = july - HOUR;
        const now = july + 5 * 60 * 1000;
        const windows: UsageWindow[] = [];
        const recorded: UsageRecord[] = [];
        const checkpoints: number[] = [];

        await runUsageRollback(
            ports({
                getCheckpoint: () => Promise.resolve(since),
                now,
                read: (window) => {
                    windows.push(window);

                    return Promise.resolve([{ meters: { requests: window.untilMs === july ? 50 : 2 }, resourceRef: "a" }]);
                },
                record: (record) => {
                    recorded.push(record);

                    return Promise.resolve();
                },
                resolveResource: () => attribution("org_a", "dep_a"),
                setCheckpoint: (ms) => {
                    checkpoints.push(ms);

                    return Promise.resolve();
                },
            }),
        );

        expect(windows).toStrictEqual([
            { sinceMs: since, untilMs: july },
            { sinceMs: july, untilMs: now },
        ]);
        // The last hour of June stays on June's bill.
        expect(recorded.map(({ periodStart, quantity }) => [periodStart, quantity])).toStrictEqual([
            [june, 50],
            [july, 2],
        ]);
        expect(checkpoints).toStrictEqual([july, now]);
    });

    it("keeps the checkpoint on the boundary when the second month's read fails, so neither part is read twice", async () => {
        const july = Date.UTC(2026, 6, 1);
        const checkpoints: number[] = [];

        await expect(
            runUsageRollback(
                ports({
                    getCheckpoint: () => Promise.resolve(july - HOUR),
                    now: july + HOUR,
                    read: (window) => (window.sinceMs === july ? Promise.reject(new Error("503")) : Promise.resolve([])),
                    setCheckpoint: (ms) => {
                        checkpoints.push(ms);

                        return Promise.resolve();
                    },
                }),
            ),
        ).rejects.toThrow("503");
        expect(checkpoints).toStrictEqual([july]);
    });

    it("splits only at month boundaries strictly inside the window", () => {
        const july = Date.UTC(2026, 6, 1);
        const august = Date.UTC(2026, 7, 1);

        expect(splitByMonth({ sinceMs: july, untilMs: july + HOUR })).toStrictEqual([{ sinceMs: july, untilMs: july + HOUR }]);
        expect(splitByMonth({ sinceMs: july - HOUR, untilMs: august + HOUR })).toStrictEqual([
            { sinceMs: july - HOUR, untilMs: july },
            { sinceMs: july, untilMs: august },
            { sinceMs: august, untilMs: august + HOUR },
        ]);
    });
});
