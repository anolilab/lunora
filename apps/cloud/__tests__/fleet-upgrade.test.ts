import { describe, expect, it } from "vitest";

import type { FleetDeployment } from "../src/fleet/upgrade";
import { planFleetUpgrade, runFleetUpgrade } from "../src/fleet/upgrade";

/** Fleet runtime re-release (GAPS.md E4 — the fat path's patch pipeline). */

const fleet = (count: number, runtimeVersion?: string): FleetDeployment[] =>
    Array.from({ length: count }, (_, index) => {
        return { deploymentId: `dep_${String(index)}`, projectId: `proj_${String(index).padStart(3, "0")}`, runtimeVersion }; // secret-scanner:allow -- domain field name
    });

describe(planFleetUpgrade, () => {
    it("canaries one, then even batches, skipping already-current projects", () => {
        const deployments = [
            ...fleet(10, "1.0.0"),
            ...fleet(3, "2.0.0").map((d, index) => {
                return { ...d, projectId: `zzz_${String(index)}` };
            }),
        ];
        const plan = planFleetUpgrade({ batchSize: 4, deployments, targetVersion: "2.0.0" });

        expect(plan.skipped).toBe(3);
        expect(plan.batches.map((batch) => batch.length)).toStrictEqual([1, 4, 4, 1]);
    });

    it("dedupes to one deployment per project and orders deterministically", () => {
        const twice = [...fleet(2, "1.0.0"), ...fleet(2, "1.0.0")];
        const plan = planFleetUpgrade({ deployments: twice, targetVersion: "2.0.0" });

        expect(plan.batches.flat()).toHaveLength(2);
        expect(plan.batches.flat().map((d) => d.projectId)).toStrictEqual(["proj_000", "proj_001"]);
    });

    it("produces no batches when the whole fleet is current", () => {
        const plan = planFleetUpgrade({ deployments: fleet(5, "2.0.0"), targetVersion: "2.0.0" });

        expect(plan.batches).toStrictEqual([]);
        expect(plan.skipped).toBe(5);
    });
});

describe(runFleetUpgrade, () => {
    it("releases the whole fleet when everything passes", async () => {
        const plan = planFleetUpgrade({ batchSize: 4, deployments: fleet(9, "1.0.0"), targetVersion: "2.0.0" });
        const result = await runFleetUpgrade(plan, { release: () => Promise.resolve(true) });

        expect(result).toStrictEqual({ failed: 0, halted: false, released: 9, remaining: 0 });
    });

    it("halts the entire run on a dirty canary — one bad release, zero blast radius", async () => {
        const plan = planFleetUpgrade({ batchSize: 4, deployments: fleet(9, "1.0.0"), targetVersion: "2.0.0" });
        const attempted: string[] = [];
        const result = await runFleetUpgrade(plan, {
            release: (deployment) => {
                attempted.push(deployment.projectId);

                return Promise.resolve(false);
            },
        });

        expect(attempted).toHaveLength(1);
        expect(result.halted).toBe(true);
        expect(result.remaining).toBe(8);
    });

    it("halts mid-fleet when the cumulative failure rate crosses the threshold", async () => {
        const plan = planFleetUpgrade({ batchSize: 4, deployments: fleet(13, "1.0.0"), targetVersion: "2.0.0" });
        let calls = 0;
        const result = await runFleetUpgrade(plan, {
            maxFailureRate: 0.25,
            // Canary passes; afterwards every second release fails (50% > 25%).
            release: () => {
                calls += 1;

                return Promise.resolve(calls === 1 || calls % 2 === 0);
            },
        });

        expect(result.halted).toBe(true);
        expect(result.remaining).toBeGreaterThan(0);
        expect(result.released + result.failed + result.remaining).toBe(13);
    });

    it("treats a throwing release as a failure, not a crash", async () => {
        const plan = planFleetUpgrade({ deployments: fleet(1, "1.0.0"), targetVersion: "2.0.0" });
        const result = await runFleetUpgrade(plan, { release: () => Promise.reject(new Error("build exploded")) });

        expect(result).toStrictEqual({ failed: 1, halted: true, released: 0, remaining: 0 });
    });
});
