/**
 * What the build dispatcher hands a build runner (`src/builds/runner-do.ts`),
 * and what each of the runner's alarms asks the control plane to do with it
 * (`POST /v1/builds/run`). A leaf, so the dispatcher's wiring never imports the
 * runner's class.
 */
import type { ClaimedBuild } from "./runner";

/**
 * Which half of a build an alarm runs: `build` (fetch and execute), `release`
 * (release and complete), or one that found its previous run cut off —
 * `interrupted` after the release half, which fails the build rather than run a
 * release twice, and `build-interrupted` after the build half, which goes on to
 * the release when that half had already stored its execution.
 */
export type BuildStage = "build" | "build-interrupted" | "interrupted" | "release";

/** One build in a runner: the claim, and the lease (`runnerId`) every one of its mutations is checked against. */
export interface BuildJob {
    build: ClaimedBuild;
    runnerId: string;
}

/** The slice of the `BUILD_RUNNER` namespace binding the dispatcher uses. */
export interface BuildRunnerNamespace {
    get: (id: DurableObjectId) => { start: (job: BuildJob) => Promise<void> };
    idFromName: (name: string) => DurableObjectId;
}
