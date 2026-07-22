import { describe, expect, it } from "vitest";

import type { UsageAttribution, UsageRollbackPorts } from "../src/metering/rollback";
import { BOOTSTRAP_WINDOW_MS, runUsageRollback } from "../src/metering/rollback";

const NOW = 1_700_000_000_000;

const attribution = (org: string, deployment: string): UsageAttribution => ({ deploymentId: deployment, organizationId: org });

const ports = (overrides: Partial<UsageRollbackPorts>): UsageRollbackPorts => ({
    getCheckpoint: () => Promise.resolve(undefined),
    now: NOW,
    read: () => Promise.resolve([]),
    record: () => Promise.resolve(),
    resolveScript: () => undefined,
    setCheckpoint: () => Promise.resolve(),
    ...overrides,
});

describe(runUsageRollback, () => {
    it("reads from the bootstrap window on first run and advances the checkpoint", async () => {
        let readSince: number | undefined;
        let checkpoint: number | undefined;

        const result = await runUsageRollback(
            ports({
                read: (since) => {
                    readSince = since;

                    return Promise.resolve([{ requests: 5, scriptName: "s-v1" }]);
                },
                resolveScript: () => attribution("org_1", "dep_1"),
                setCheckpoint: (ms) => {
                    checkpoint = ms;

                    return Promise.resolve();
                },
            }),
        );

        expect(readSince).toBe(NOW - BOOTSTRAP_WINDOW_MS);
        expect(checkpoint).toBe(NOW);
        expect(result).toStrictEqual({ attributed: 1, failed: 0, requests: 5, skipped: 0 });
    });

    it("delta-reads from the stored checkpoint (no double count across runs)", async () => {
        let readSince: number | undefined;

        await runUsageRollback(
            ports({
                getCheckpoint: () => Promise.resolve(NOW - 30_000),
                read: (since) => {
                    readSince = since;

                    return Promise.resolve([]);
                },
            }),
        );

        expect(readSince).toBe(NOW - 30_000);
    });

    it("records one ledger row per attributed script with the summed count", async () => {
        const recorded: { org: string; quantity: number }[] = [];

        const result = await runUsageRollback(
            ports({
                read: () =>
                    Promise.resolve([
                        { requests: 12, scriptName: "a-v1" },
                        { requests: 3, scriptName: "b-v2" },
                    ]),
                record: ({ attribution: a, quantity }) => {
                    recorded.push({ org: a.organizationId, quantity });

                    return Promise.resolve();
                },
                resolveScript: (script) => (script === "a-v1" ? attribution("org_a", "dep_a") : attribution("org_b", "dep_b")),
            }),
        );

        expect(recorded).toStrictEqual([
            { org: "org_a", quantity: 12 },
            { org: "org_b", quantity: 3 },
        ]);
        expect(result.requests).toBe(15);
    });

    it("skips scripts with no matching deployment and zero-count rows", async () => {
        const result = await runUsageRollback(
            ports({
                read: () =>
                    Promise.resolve([
                        { requests: 9, scriptName: "gone-v1" },
                        { requests: 0, scriptName: "idle-v1" },
                    ]),
                resolveScript: () => undefined,
            }),
        );

        expect(result).toStrictEqual({ attributed: 0, failed: 0, requests: 0, skipped: 1 });
    });

    it("drops a failed ledger write but still advances the checkpoint (under-count, never double-bill)", async () => {
        let checkpoint: number | undefined;

        const result = await runUsageRollback(
            ports({
                read: () =>
                    Promise.resolve([
                        { requests: 4, scriptName: "ok-v1" },
                        { requests: 7, scriptName: "boom-v1" },
                    ]),
                record: ({ attribution: a }) => (a.organizationId === "org_boom" ? Promise.reject(new Error("d1 write failed")) : Promise.resolve()),
                resolveScript: (script) => (script === "ok-v1" ? attribution("org_ok", "dep_ok") : attribution("org_boom", "dep_boom")),
                setCheckpoint: (ms) => {
                    checkpoint = ms;

                    return Promise.resolve();
                },
            }),
        );

        expect(result).toStrictEqual({ attributed: 1, failed: 1, requests: 4, skipped: 0 });
        // Checkpoint advances despite the failure — the dropped count is lost, not retried.
        expect(checkpoint).toBe(NOW);
    });

    it("propagates an AE read failure without advancing the checkpoint", async () => {
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
