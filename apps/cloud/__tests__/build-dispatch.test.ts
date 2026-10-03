import { describe, expect, it } from "vitest";

import type { BuildDispatchPorts } from "../src/builds/dispatch";
import { claimBuilds, DEFAULT_MAX_BUILDS_PER_TICK } from "../src/builds/dispatch";
import type { ClaimedBuild } from "../src/builds/runner";
import type { BuildJob } from "../src/builds/runner-job";

/**
 * The cron's half of a git build (GAPS.md A3): it claims queued builds and hands
 * each to its own runner, and never runs one — the build and its release run in
 * the runner's own alarms (`build-runner.test.ts`), off the tick's wall-clock cap.
 */

const claimed = (id: string): ClaimedBuild => {
    return { buildId: id, commitSha: `sha-${id}`, projectId: `proj-${id}` };
};

/** A claimNext that hands out the given builds in order, then returns null (drained). */
const queue = (builds: ClaimedBuild[]): ((runnerId: string) => Promise<ClaimedBuild | null>) => {
    let index = 0;

    return () => {
        const build = builds[index] ?? null;

        index += 1;

        return Promise.resolve(build);
    };
};

const ports = (overrides: Partial<BuildDispatchPorts>): BuildDispatchPorts => {
    return {
        claimNext: queue([]),
        fail: () => Promise.resolve(),
        handOff: () => Promise.resolve(),
        runnerId: "runner-1",
        ...overrides,
    };
};

describe(claimBuilds, () => {
    it("hands every claimed build to its runner under the tick's lease, in claim order", async () => {
        const handed: BuildJob[] = [];

        const result = await claimBuilds(
            ports({
                claimNext: queue([claimed("a"), claimed("b")]),
                handOff: (build, runnerId) => {
                    handed.push({ build, runnerId });

                    return Promise.resolve();
                },
            }),
        );

        expect(result).toStrictEqual({ handedOff: ["a", "b"] });
        expect(handed).toStrictEqual([
            { build: claimed("a"), runnerId: "runner-1" },
            { build: claimed("b"), runnerId: "runner-1" },
        ]);
    });

    it("stops at the per-tick cap, leaving the rest queued for the next tick", async () => {
        let claims = 0;

        const result = await claimBuilds(
            ports({
                claimNext: () => {
                    claims += 1;

                    return Promise.resolve(claimed(String(claims)));
                },
            }),
            2,
        );

        expect(claims).toBe(2);
        expect(result.handedOff).toStrictEqual(["1", "2"]);
    });

    it("claims as many builds a tick as the build box runs at once", async () => {
        const builds = Array.from({ length: DEFAULT_MAX_BUILDS_PER_TICK + 2 }, (_, index) => claimed(String(index)));

        const result = await claimBuilds(ports({ claimNext: queue(builds) }));

        expect(result.handedOff).toHaveLength(DEFAULT_MAX_BUILDS_PER_TICK);
    });

    it("fails a build its runner would not take, with the reason, and keeps claiming", async () => {
        const failed: [string, string][] = [];

        const result = await claimBuilds(
            ports({
                claimNext: queue([claimed("boom"), claimed("ok")]),
                fail: (buildId, error) => {
                    failed.push([buildId, error]);

                    return Promise.resolve();
                },
                handOff: (build) => (build.buildId === "boom" ? Promise.reject(new Error("no BUILD_RUNNER")) : Promise.resolve()),
            }),
        );

        expect(result.handedOff).toStrictEqual(["ok"]);
        expect(failed).toStrictEqual([["boom", "the build could not be handed to a runner: no BUILD_RUNNER"]]);
    });

    it("stops as soon as the queue is empty", async () => {
        let claims = 0;

        await expect(
            claimBuilds(
                ports({
                    claimNext: () => {
                        claims += 1;

                        return Promise.resolve(null);
                    },
                }),
            ),
        ).resolves.toStrictEqual({ handedOff: [] });
        expect(claims).toBe(1);
    });
});
