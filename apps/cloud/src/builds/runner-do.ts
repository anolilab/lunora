/**
 * `BuildRunnerDO` — one per git build, named by its id (GAPS.md A3): where a
 * claimed build actually runs, off the cron path.
 *
 * The every-minute cron only claims builds and hands each one here
 * ({@link BuildRunnerDO.start}); everything slow happens in this object's own
 * alarm invocations. Each runs ONE half of the build through the control
 * plane's `POST /v1/builds/run`, called in-process on the Worker
 * (`controlPlaneWorker`), which is how the half gets the Lunora context its
 * mutations and its release need:
 *
 * 1. `build` — fetch the source and execute it in the build box, then store the
 *    execution in `RELEASES`.
 * 2. `release` — release the stored execution through the deploy core and
 *    complete the build.
 *
 * Why halves: an alarm invocation runs for at most 15 minutes of wall time
 * (https://developers.cloudflare.com/workers/platform/limits/ — "Alarm handler
 * invocations have a maximum wall time of 15 minutes"), the same cap the cron
 * tick has, and a build (up to `BUILD_EXECUTE_BUDGET_MS`, 9 minutes) plus a box
 * release (up to 10 minutes) does not fit one. Each half fits its own. Both stay
 * inside the build's lease (`LEASE_STALE_MS`, 30 minutes), whose `runnerId` they
 * share.
 *
 * Alarms are retried when an invocation fails or is cut off
 * (https://developers.cloudflare.com/durable-objects/api/alarms/). A half is
 * marked started before it runs, so a retry that finds it started fails the
 * build (`interrupted`) instead of running a release twice.
 */
import { DurableObject } from "cloudflare:workers";

import { ensureAuth } from "../auth";
import type { ControlPlaneEnv } from "../control-plane-env";
import { controlPlaneWorker } from "../control-plane-worker";
import type { BuildStageResult } from "./control-plane";
import type { BuildJob, BuildStage } from "./runner-job";

/** Where the runner reaches its own Worker. Never resolved — the request is handed over in-process. */
const BUILD_RUN_URL = "https://control-plane.internal/v1/builds/run";

/** What the runner keeps in storage between its alarms. */
interface RunnerState {
    job: BuildJob;
    /** The half the next alarm runs. */
    stage: Exclude<BuildStage, "interrupted">;
    /** Set while that half runs: an alarm that finds it set was cut off. */
    started?: boolean;
}

const STATE_KEY = "run";

export class BuildRunnerDO extends DurableObject<ControlPlaneEnv> {
    /** Take a claimed build and run it, starting now. Idempotent for the same build: a second start is ignored. */
    public async start(job: BuildJob): Promise<void> {
        if ((await this.ctx.storage.get<RunnerState>(STATE_KEY)) !== undefined) {
            return;
        }

        await this.ctx.storage.put(STATE_KEY, { job, stage: "build" } satisfies RunnerState);
        await this.ctx.storage.setAlarm(Date.now());
    }

    /** Run the next half of the build, then schedule the one after it or forget the build. */
    public override async alarm(): Promise<void> {
        const state = await this.ctx.storage.get<RunnerState>(STATE_KEY);

        if (state === undefined) {
            return;
        }

        const stage: BuildStage = state.started === true ? "interrupted" : state.stage;

        await this.ctx.storage.put(STATE_KEY, { ...state, started: true } satisfies RunnerState);

        const result = await this.runStage(state.job, stage);

        if (result.next === null) {
            await this.ctx.storage.delete(STATE_KEY);

            return;
        }

        await this.ctx.storage.put(STATE_KEY, { job: state.job, stage: result.next } satisfies RunnerState);
        await this.ctx.storage.setAlarm(Date.now());
    }

    /** Run one half through the control plane's own route, in-process. */
    protected async runStage(job: BuildJob, stage: BuildStage): Promise<BuildStageResult> {
        const environment = this.env;

        if (!environment.LUNORA_ADMIN_TOKEN) {
            throw new Error("the build runner needs LUNORA_ADMIN_TOKEN to reach /v1/builds/run");
        }

        // The worker reads the auth instance; this isolate may not have built it yet.
        await ensureAuth(environment, environment.LUNORA_ORIGIN_URL ?? new URL(BUILD_RUN_URL).origin);

        const response = await controlPlaneWorker(environment).fetch(
            new Request(BUILD_RUN_URL, {
                body: JSON.stringify({ job, stage }),
                headers: { authorization: `Bearer ${environment.LUNORA_ADMIN_TOKEN}`, "content-type": "application/json" },
                method: "POST",
            }),
            environment,
            this.ctx,
        );

        if (!response.ok) {
            // Thrown, so the alarm is retried — and that retry, finding the half
            // started, fails the build with the reason instead of running it again.
            throw new Error(`the ${stage} half of build ${job.build.buildId} answered ${String(response.status)}: ${await response.text().catch(() => "")}`);
        }

        return response.json<BuildStageResult>();
    }
}
