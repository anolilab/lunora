import { describe, expect, it } from "vitest";

import type { BuildStageResult } from "../src/builds/control-plane";
import { runBuildStage } from "../src/builds/control-plane";
import { BuildRunnerDO } from "../src/builds/runner-do";
import type { BuildJob, BuildStage } from "../src/builds/runner-job";
import type { RouterEnv } from "../src/deploy/routes/shared";

/**
 * A git build's runner (GAPS.md A3): each half of the build runs in its own
 * alarm invocation, so neither the cron that claimed it nor any one alarm has
 * to fit a build AND its release inside 15 minutes of wall time.
 */

const job: BuildJob = { build: { buildId: "bld_1", commitSha: "abc", projectId: "prj_1" }, runnerId: "edge-1" }; // secret-scanner:allow -- domain field name

/** The slice of `DurableObjectState` the runner uses. */
const fakeState = () => {
    const values = new Map<string, unknown>();
    const state = {
        alarmAt: null as null | number,
        storage: {
            delete: (key: string) => Promise.resolve(values.delete(key)),
            get: <T>(key: string) => Promise.resolve(values.get(key) as T | undefined),
            put: (key: string, value: unknown) => {
                values.set(key, structuredClone(value));

                return Promise.resolve();
            },
            setAlarm: (time: number) => {
                state.alarmAt = time;

                return Promise.resolve();
            },
        },
        values,
    };

    return state;
};

/** A runner whose halves answer from `answers` instead of the control plane, recording each stage it ran. */
class TestRunner extends BuildRunnerDO {
    public readonly ran: BuildStage[] = [];

    private readonly answers: ((stage: BuildStage) => Promise<BuildStageResult>)[];

    public constructor(state: ReturnType<typeof fakeState>, answers: ((stage: BuildStage) => Promise<BuildStageResult>)[]) {
        // The fake is the slice of the runtime's state the runner reads.
        super(state as unknown as DurableObjectState, {} as never);
        this.answers = answers;
    }

    protected override runStage(_job: BuildJob, stage: BuildStage): Promise<BuildStageResult> {
        this.ran.push(stage);

        const answer = this.answers.shift();

        return answer ? answer(stage) : Promise.reject(new Error("no answer left"));
    }
}

describe(BuildRunnerDO, () => {
    it("takes a claimed build and runs it from the next alarm; a second start of the same build is ignored", async () => {
        const state = fakeState();
        const runner = new TestRunner(state, []);

        await runner.start(job);
        state.alarmAt = null;
        await runner.start({ ...job, runnerId: "edge-2" });

        expect(state.values.get("run")).toStrictEqual({ job, stage: "build" });
        expect(state.alarmAt).toBeNull();
    });

    it("builds in one alarm and releases in the next, then forgets the build", async () => {
        const state = fakeState();
        const runner = new TestRunner(state, [() => Promise.resolve({ next: "release" }), () => Promise.resolve({ next: null })]);

        await runner.start(job);
        await runner.alarm();

        expect(state.values.get("run")).toStrictEqual({ job, stage: "release" });
        expect(state.alarmAt).not.toBeNull();

        await runner.alarm();

        expect(runner.ran).toStrictEqual(["build", "release"]);
        expect(state.values.has("run")).toBe(false);
    });

    it("fails the build rather than run a half twice when the alarm that ran it was cut off", async () => {
        const state = fakeState();
        const runner = new TestRunner(state, [() => Promise.reject(new Error("alarm exceeded its wall time")), () => Promise.resolve({ next: null })]);

        await runner.start(job);
        await runner.alarm().catch(() => undefined);
        // The runtime retries the alarm; the half it finds started is not run again.
        await runner.alarm();

        expect(runner.ran).toStrictEqual(["build", "interrupted"]);
        expect(state.values.has("run")).toBe(false);
    });

    it("does nothing on an alarm with no build", async () => {
        const runner = new TestRunner(fakeState(), []);

        await expect(runner.alarm()).resolves.toBeUndefined();
        expect(runner.ran).toStrictEqual([]);
    });
});

describe(runBuildStage, () => {
    const wiring = () => {
        const mutations: Record<string, unknown>[] = [];
        const context = {
            runAction: () => Promise.reject(new Error("unused")),
            runMutation: <R>(_reference: unknown, args: Record<string, unknown> = {}) => {
                mutations.push(args);

                return Promise.resolve(undefined as R);
            },
            runQuery: <R>() => Promise.resolve(null as R),
        } as NonNullable<RouterEnv["__lunoraCtx"]>;

        return { input: { context, deploy: undefined, environment: {} }, mutations };
    };

    it("fails an interrupted build under its own lease, with the reason", async () => {
        const { input, mutations } = wiring();

        await expect(runBuildStage(input, job, "interrupted")).resolves.toStrictEqual({ next: null });
        expect(mutations.at(-1)).toMatchObject({ buildId: "bld_1", error: expect.stringContaining("cut off mid-run") as string, runnerId: "edge-1" });
    });

    it("fails a release whose execution was not kept", async () => {
        const { input, mutations } = wiring();

        await expect(runBuildStage(input, job, "release")).resolves.toStrictEqual({ next: null });
        expect(mutations.at(-1)).toMatchObject({ buildId: "bld_1", error: expect.stringContaining("not kept") as string, runnerId: "edge-1" });
    });
});
