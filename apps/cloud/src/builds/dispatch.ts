/**
 * Build-queue dispatcher (GAPS.md A3). The queue side already exists —
 * `builds.recordPush` enqueues, `builds.claimNext` leases, `runBuild` drives one
 * build through fetch → execute → complete/fail → release. What was missing is
 * the loop that *claims* work and hands it to the runner; without it `claimNext`
 * has no caller and every enqueued build sits until the 24h expiry cron fails it.
 * This is that loop.
 *
 * Pure over injected ports. The runner's `execute` (a throwaway Cloudflare
 * Container running `lunora build`) and `fetchSource` (GitHub App tarball) are
 * the 🌐 seams; this dispatcher is pure claim→run orchestration and is fully
 * unit-tested. It drains a bounded number of builds per tick so one busy cell
 * can't monopolise a scheduled invocation.
 */
import type { BuildOutcome, BuildRunnerPorts, ClaimedBuild } from "./runner";
import { runBuild } from "./runner";

export interface BuildDispatchPorts {
    /** Lease the next runnable build for this runner, or null when the queue is empty. */
    claimNext: (runnerId: string) => Promise<ClaimedBuild | null>;
    /** Ports the runner drives a claimed build through (logs / complete / fail / fetch / execute / release). */
    runnerPorts: BuildRunnerPorts;
    /** Stable id identifying this runner instance on the lease. */
    runnerId: string;
}

export interface BuildDispatchResult {
    /** Outcomes of the builds run this tick, in claim order. */
    outcomes: BuildOutcome[];
}

/** Default per-tick drain cap — bounds Cloudflare/container work in one scheduled invocation. */
export const DEFAULT_MAX_BUILDS_PER_TICK = 5;

/**
 * Claim and run up to `maxBuilds` builds in one tick, stopping as soon as the
 * queue drains. `runBuild` never throws (it reports failures through the
 * runner's `fail` port), so a bad build can't abort the drain.
 */
export const runBuildDispatch = async (ports: BuildDispatchPorts, maxBuilds: number = DEFAULT_MAX_BUILDS_PER_TICK): Promise<BuildDispatchResult> => {
    const outcomes: BuildOutcome[] = [];

    for (let claimed = 0; claimed < maxBuilds; claimed += 1) {
        // eslint-disable-next-line no-await-in-loop -- builds run sequentially so leases don't overlap on one runner
        const build = await ports.claimNext(ports.runnerId);

        if (!build) {
            break;
        }

        // eslint-disable-next-line no-await-in-loop -- one build at a time per runner
        outcomes.push(await runBuild(build, ports.runnerPorts));
    }

    return { outcomes };
};
