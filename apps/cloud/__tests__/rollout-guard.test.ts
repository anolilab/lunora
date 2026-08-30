import { describe, expect, it, vi } from "vitest";

import type { OpenRollout, RolloutHealthReader } from "../src/deploy/rollout-guard";
import { judgeRollout, judgeRollouts, ROLLOUT_GUARD_MIN_REQUESTS, ROLLOUT_GUARD_WINDOW_MS, runRolloutGuard, scriptsToRead } from "../src/deploy/rollout-guard";
import type { ControlPlaneDatabase } from "../src/store";
import type { ScriptHealth } from "../src/telemetry/traffic-read";

/** A fake ControlPlaneDatabase answering findMany per-table, mirroring alert-sweep.test.ts. */
const fakeDb = (pages: Record<string, unknown[]>, spies: Partial<ControlPlaneDatabase> = {}): ControlPlaneDatabase => {
    return {
        delete: () => Promise.resolve(undefined),
        findMany: (table) => Promise.resolve({ page: pages[table] ?? [] }),
        insert: () => Promise.resolve("row_id"),
        patch: () => Promise.resolve(undefined),
        ...spies,
    };
};

const health = (entries: { errors: number; requests: number; scriptName: string }[]): Map<string, ScriptHealth> =>
    new Map(
        entries.map((entry) => [
            entry.scriptName,
            {
                errorRate: entry.requests === 0 ? 0 : entry.errors / entry.requests,
                errors: entry.errors,
                requests: entry.requests,
                scriptName: entry.scriptName,
            },
        ]),
    );

const rollout: OpenRollout = {
    activeScriptName: "acme-app",
    candidateScriptName: "acme-app-v2",
    organizationId: "org1",
    percent: 10,
    projectId: "proj1",
    projectName: "Acme",
};

describe(judgeRollout, () => {
    it("aborts a candidate failing materially worse than the active release", () => {
        const reason = judgeRollout(
            rollout,
            health([
                { errors: 40, requests: 100, scriptName: "acme-app-v2" },
                { errors: 2, requests: 900, scriptName: "acme-app" },
            ]),
        );

        expect(reason).toContain("40.0%");
        expect(reason).toContain("0.2%");
    });

    it("leaves a candidate running when it matches the active release's own error rate", () => {
        // 20% vs 19% — an app that legitimately errors is not a regression, which is
        // the whole reason the baseline is the active release rather than a constant.
        expect(
            judgeRollout(
                rollout,
                health([
                    { errors: 20, requests: 100, scriptName: "acme-app-v2" },
                    { errors: 190, requests: 1000, scriptName: "acme-app" },
                ]),
            ),
        ).toBeNull();
    });

    it("will not judge a candidate that has not served enough traffic", () => {
        const thin = ROLLOUT_GUARD_MIN_REQUESTS - 1;

        // Every request failed, and it is still not evidence.
        expect(
            judgeRollout(
                rollout,
                health([
                    { errors: thin, requests: thin, scriptName: "acme-app-v2" },
                    { errors: 0, requests: 900, scriptName: "acme-app" },
                ]),
            ),
        ).toBeNull();
    });

    it("falls back to an absolute rate when the active release has too little traffic to compare", () => {
        const reason = judgeRollout(
            rollout,
            health([
                { errors: 60, requests: 100, scriptName: "acme-app-v2" },
                { errors: 0, requests: 3, scriptName: "acme-app" },
            ]),
        );

        expect(reason).toContain("too little traffic");
    });

    it("does not fall back to the absolute rate when the active release IS comparable and healthy-ish", () => {
        // 60% candidate vs 58% active: over the absolute floor, but inside the margin
        // against a real baseline — so the baseline wins and the rollout survives.
        expect(
            judgeRollout(
                rollout,
                health([
                    { errors: 60, requests: 100, scriptName: "acme-app-v2" },
                    { errors: 580, requests: 1000, scriptName: "acme-app" },
                ]),
            ),
        ).toBeNull();
    });

    it("uses the absolute rate for a project with no active release at all", () => {
        const orphan: OpenRollout = { ...rollout, activeScriptName: undefined };

        expect(judgeRollout(orphan, health([{ errors: 90, requests: 100, scriptName: "acme-app-v2" }]))).toContain("too little traffic");
    });
});

describe(scriptsToRead, () => {
    it("collects both sides of every rollout, deduplicated", () => {
        expect(scriptsToRead([rollout, { ...rollout, candidateScriptName: "other-v2", projectId: "proj2" }])).toStrictEqual([
            "acme-app-v2",
            "acme-app",
            "other-v2",
        ]);
    });

    it("omits an absent or empty active script rather than reading a blank name", () => {
        expect(scriptsToRead([{ ...rollout, activeScriptName: "" }])).toStrictEqual(["acme-app-v2"]);
    });
});

describe(judgeRollouts, () => {
    it("judges each rollout independently against one health read", () => {
        const aborts = judgeRollouts(
            [rollout, { ...rollout, candidateScriptName: "healthy-v2", projectId: "proj2" }],
            health([
                { errors: 90, requests: 100, scriptName: "acme-app-v2" },
                { errors: 0, requests: 100, scriptName: "healthy-v2" },
                { errors: 0, requests: 900, scriptName: "acme-app" },
            ]),
        );

        expect(aborts).toHaveLength(1);
        expect(aborts[0]?.rollout.projectId).toBe("proj1");
    });
});

const projectRow = {
    _id: "proj1",
    activeScriptName: "acme-app",
    name: "Acme",
    organizationId: "org1",
    rollout: { deploymentId: "dep2", percent: 10, scriptName: "acme-app-v2" },
};

const reader = (map: Map<string, ScriptHealth>): RolloutHealthReader => {
    return { readScriptHealth: () => Promise.resolve(map) };
};

describe(runRolloutGuard, () => {
    it("clears the rollout, audits it as automatic, and raises a deploy alert", async () => {
        const insert = vi.fn<ControlPlaneDatabase["insert"]>((table: string) => Promise.resolve(`${table}_id`));
        const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));
        const database = fakeDb(
            {
                alertRules: [{ _id: "rule1", channel: "slack", destination: "https://hooks.slack.com/x", enabled: true, name: "Releases", target: "deploy" }],
                projects: [projectRow],
            },
            { insert, patch },
        );

        const result = await runRolloutGuard(database, {
            now: 1_000_000,
            reader: reader(
                health([
                    { errors: 90, requests: 100, scriptName: "acme-app-v2" },
                    { errors: 0, requests: 900, scriptName: "acme-app" },
                ]),
            ),
        });

        expect(result.examined).toBe(1);
        expect(result.aborted).toHaveLength(1);

        // All traffic returns to the active release.
        expect(patch).toHaveBeenCalledWith("proj1", { rollout: undefined }, "projects");
        // Distinguishable from a human abort in the audit trail.
        expect(insert).toHaveBeenCalledWith(
            "auditLog",
            expect.objectContaining({ action: "deployment.rollout.auto_abort", actorUserId: "system:rollout-guard" }),
        );
        // And somebody is told, with the reason in the body.
        expect(insert).toHaveBeenCalledWith("alerts", expect.objectContaining({ status: "firing", target: "deploy" }));
        expect(insert.mock.calls.find((call) => call[0] === "alerts")?.[1]).toMatchObject({ body: expect.stringContaining("90.0%") });
    });

    it("leaves a healthy rollout completely alone", async () => {
        const insert = vi.fn<ControlPlaneDatabase["insert"]>(() => Promise.resolve("id"));
        const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));
        const database = fakeDb({ projects: [projectRow] }, { insert, patch });

        const result = await runRolloutGuard(database, {
            now: 1_000_000,
            reader: reader(
                health([
                    { errors: 0, requests: 100, scriptName: "acme-app-v2" },
                    { errors: 0, requests: 900, scriptName: "acme-app" },
                ]),
            ),
        });

        expect(result.aborted).toStrictEqual([]);
        expect(patch).not.toHaveBeenCalled();
        expect(insert).not.toHaveBeenCalled();
    });

    it("reads no traffic at all when nothing is rolling out", async () => {
        const readScriptHealth = vi.fn<RolloutHealthReader["readScriptHealth"]>(() => Promise.resolve(new Map<string, ScriptHealth>()));
        const database = fakeDb({ projects: [{ _id: "proj1", name: "Acme", organizationId: "org1" }] });

        const result = await runRolloutGuard(database, { now: 1_000_000, reader: { readScriptHealth } });

        expect(result).toStrictEqual({ aborted: [], examined: 0 });
        // The AE read is billed per query — a platform with no open rollout must not pay for one every minute.
        expect(readScriptHealth).not.toHaveBeenCalled();
    });

    it("reads exactly the trailing window it judges on", async () => {
        const readScriptHealth = vi.fn<RolloutHealthReader["readScriptHealth"]>(() => Promise.resolve(new Map<string, ScriptHealth>()));
        const database = fakeDb({ projects: [projectRow] });
        const now = 1_000_000;

        await runRolloutGuard(database, { now, reader: { readScriptHealth } });

        expect(readScriptHealth).toHaveBeenCalledWith({ from: now - ROLLOUT_GUARD_WINDOW_MS, scriptNames: ["acme-app-v2", "acme-app"], to: now });
    });

    it("aborts nothing when the traffic read fails — no evidence is not evidence of a bad release", async () => {
        const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));
        const database = fakeDb({ projects: [projectRow] }, { patch });

        await expect(
            runRolloutGuard(database, { now: 1_000_000, reader: { readScriptHealth: () => Promise.reject(new Error("AE unreachable")) } }),
        ).rejects.toThrow("AE unreachable");
        expect(patch).not.toHaveBeenCalled();
    });
});
