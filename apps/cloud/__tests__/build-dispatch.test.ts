import { describe, expect, it } from "vitest";

import type { BuildDispatchPorts } from "../src/builds/dispatch";
import { runBuildDispatch } from "../src/builds/dispatch";
import type { BuildRunnerPorts, ClaimedBuild } from "../src/builds/runner";

const claimed = (id: string): ClaimedBuild => ({ buildId: id, commitSha: `sha-${id}`, projectId: `proj-${id}` });

/** A runner-ports fake that records the lifecycle and returns a fixed execution. */
const runnerPorts = (overrides: Partial<BuildRunnerPorts> = {}): BuildRunnerPorts => ({
    appendLog: () => Promise.resolve(),
    complete: () => Promise.resolve(),
    execute: () => Promise.resolve({ bundle: "YnVuZGxl", bundleHash: "hash" }),
    fail: () => Promise.resolve(),
    fetchSource: () => Promise.resolve(new ArrayBuffer(8)),
    ...overrides,
});

/** A claimNext that hands out the given builds in order, then returns null (drained). */
const queue = (builds: ClaimedBuild[]): ((runnerId: string) => Promise<ClaimedBuild | null>) => {
    let index = 0;

    return () => Promise.resolve(index < builds.length ? builds[index++] : null);
};

const ports = (overrides: Partial<BuildDispatchPorts>): BuildDispatchPorts => ({
    claimNext: queue([]),
    runnerId: "runner-1",
    runnerPorts: runnerPorts(),
    ...overrides,
});

describe(runBuildDispatch, () => {
    it("drains the queue, running each claimed build to a successful outcome", async () => {
        const completed: string[] = [];

        const result = await runBuildDispatch(
            ports({
                claimNext: queue([claimed("a"), claimed("b")]),
                runnerPorts: runnerPorts({
                    complete: (buildId) => {
                        completed.push(buildId);

                        return Promise.resolve();
                    },
                }),
            }),
        );

        expect(completed).toStrictEqual(["a", "b"]);
        expect(result.outcomes).toStrictEqual([
            { bundleHash: "hash", status: "successful" },
            { bundleHash: "hash", status: "successful" },
        ]);
    });

    it("stops immediately when the queue is empty", async () => {
        let claims = 0;

        const result = await runBuildDispatch(
            ports({
                claimNext: () => {
                    claims += 1;

                    return Promise.resolve(null);
                },
            }),
        );

        expect(claims).toBe(1);
        expect(result.outcomes).toStrictEqual([]);
    });

    it("respects the per-tick drain cap and leaves the rest for the next tick", async () => {
        let claims = 0;

        const result = await runBuildDispatch(
            ports({
                claimNext: () => {
                    claims += 1;

                    return Promise.resolve(claimed(String(claims)));
                },
            }),
            2,
        );

        expect(claims).toBe(2);
        expect(result.outcomes).toHaveLength(2);
    });

    it("keeps draining after a failed build (runBuild reports failure, never throws)", async () => {
        const result = await runBuildDispatch(
            ports({
                claimNext: queue([claimed("boom"), claimed("ok")]),
                runnerPorts: runnerPorts({
                    execute: (_source, onLine) =>
                        onLine("building").then(() => {
                            throw new Error("container OOM");
                        }),
                }),
            }),
        );

        // Both builds were attempted; the first failed but did not abort the drain.
        expect(result.outcomes).toHaveLength(2);
        expect(result.outcomes.every((outcome) => outcome.status === "failed")).toBe(true);
    });

    it("passes the runner id through to the lease", async () => {
        let seenRunnerId: string | undefined;

        await runBuildDispatch(
            ports({
                claimNext: (runnerId) => {
                    seenRunnerId = runnerId;

                    return Promise.resolve(null);
                },
                runnerId: "cell-a-runner",
            }),
        );

        expect(seenRunnerId).toBe("cell-a-runner");
    });
});
