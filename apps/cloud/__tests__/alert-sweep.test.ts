import { describe, expect, it, vi } from "vitest";

import type { ControlPlaneDb } from "../src/deploy/sweeps";
import type { MetricObservation } from "../src/telemetry/alerts";
import { runAlertSweep } from "../src/telemetry/sweep";

/** A fake ControlPlaneDb answering findMany per-table, mirroring uptime.test.ts. */
const fakeDb = (pages: Record<string, unknown[]>, spies: Partial<ControlPlaneDb> = {}): ControlPlaneDb => ({
    findMany: (table) => Promise.resolve({ page: pages[table] ?? [] }),
    insert: () => Promise.resolve("row_id"),
    patch: () => Promise.resolve(undefined),
    ...spies,
});

const now = 10 * 60_000; // 10 minutes in

/** N observations, `errors` of which are error-level, in the current 5-min window. */
const window = (total: number, errors: number): MetricObservation[] =>
    Array.from({ length: total }, (_, index) => ({
        durationMs: 10,
        kind: "worker" as const,
        level: index < errors ? ("error" as const) : ("info" as const),
        startedAt: now - 60_000,
    }));

/** One enabled `error_rate > 50` rule over a 5-minute window, delivered by webhook. */
const errorRateRule = {
    _id: "rule1",
    channel: "webhook",
    comparator: "gt",
    destination: "https://hook.example",
    enabled: true,
    name: "High error rate",
    organizationId: "org1",
    target: "error_rate",
    threshold: 50,
    windowMinutes: 5,
};

describe(runAlertSweep, () => {
    it("re-fires a quiet error_rate window that the ingest path missed (no latch yet)", async () => {
        const insert = vi.fn((table: string) => Promise.resolve(`${table}_id`));
        const database = fakeDb(
            {
                alertRuleState: [], // never latched → wasFiring is false
                alertRules: [errorRateRule],
                observations: window(2, 2), // 100% error in the current window
            },
            { insert },
        );

        const result = await runAlertSweep(database, { now });

        expect(result.evaluatedOrgs).toBe(1);
        expect(result.deliveries).toHaveLength(1);
        expect(result.deliveries[0]?.subject).toContain("Error rate above threshold");
        // Fires an alert row AND latches the rule so it won't re-fire next tick.
        expect(insert).toHaveBeenCalledWith("alerts", expect.objectContaining({ ruleId: "rule1", status: "firing", target: "error_rate" }));
        expect(insert).toHaveBeenCalledWith("alertRuleState", expect.objectContaining({ firing: true, ruleId: "rule1" }));
    });

    it("clears a firing rule when its window falls back under threshold — no alert, latch reset", async () => {
        const insert = vi.fn((table: string) => Promise.resolve(`${table}_id`));
        const patch = vi.fn(() => Promise.resolve(undefined));
        const database = fakeDb(
            {
                alertRuleState: [{ _id: "state1", firing: true, ruleId: "rule1" }],
                alertRules: [errorRateRule],
                observations: window(4, 0), // recovered: 0% error
            },
            { insert, patch },
        );

        const result = await runAlertSweep(database, { now });

        expect(result.cleared).toBe(1);
        expect(result.deliveries).toStrictEqual([]);
        // Latch reset via patch on the existing state row; no alert row written.
        expect(patch).toHaveBeenCalledWith("state1", expect.objectContaining({ firing: false }), "alertRuleState");
        expect(insert).not.toHaveBeenCalledWith("alerts", expect.anything());
    });

    it("does not re-fire while the rule stays firing (latched, still breaching)", async () => {
        const insert = vi.fn((table: string) => Promise.resolve(`${table}_id`));
        const patch = vi.fn(() => Promise.resolve(undefined));
        const database = fakeDb(
            {
                alertRuleState: [{ _id: "state1", firing: true, ruleId: "rule1" }],
                alertRules: [errorRateRule],
                observations: window(2, 2), // still 100% error
            },
            { insert, patch },
        );

        const result = await runAlertSweep(database, { now });

        expect(result.deliveries).toStrictEqual([]);
        expect(result.cleared).toBe(0);
        expect(insert).not.toHaveBeenCalled();
        expect(patch).not.toHaveBeenCalled(); // no state change → no write
    });

    it("ignores disabled rules and non-metric targets (never scans observations)", async () => {
        const findMany = vi.fn((table: string) =>
            Promise.resolve({
                page:
                    table === "alertRules"
                        ? [
                              { ...errorRateRule, enabled: false },
                              { ...errorRateRule, _id: "u", target: "uptime" },
                          ]
                        : [],
            }),
        );
        const database = fakeDb({}, { findMany });

        const result = await runAlertSweep(database, { now });

        expect(result.evaluatedOrgs).toBe(0);
        expect(result.deliveries).toStrictEqual([]);
        // No metric rule ⇒ never reads observations or state.
        expect(findMany).not.toHaveBeenCalledWith("observations", expect.anything());
        expect(findMany).not.toHaveBeenCalledWith("alertRuleState", expect.anything());
    });
});
