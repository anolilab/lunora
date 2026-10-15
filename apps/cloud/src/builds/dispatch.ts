/**
 * Build-queue dispatcher (GAPS.md A3): the loop that CLAIMS queued builds and
 * hands each to its own runner. `builds.recordPush` enqueues, `builds.claimNext`
 * leases, and a build runner (`src/builds/runner-do.ts`, one Durable Object per
 * build) fetches, executes, releases and completes it — in its own alarm
 * invocations, never in the cron tick that claimed it. That is what frees a
 * build and its release from the tick's 15-minute wall-clock cap: a tick only
 * claims and hands off, which takes seconds.
 *
 * Pure over injected ports, so the claim → hand-off order is unit-tested.
 */
import type { ClaimedBuild } from "./runner";

export interface BuildDispatchPorts {
    /** Lease the next runnable build for this runner, or null when the queue is empty. */
    claimNext: (runnerId: string) => Promise<ClaimedBuild | null>;
    /** Fail a claimed build that could not be handed off, with the reason. Lease-checked upstream. */
    fail: (buildId: string, error: string) => Promise<void>;
    /** Hand a claimed build to its runner, which runs it under `runnerId`'s lease. Resolves once the runner has it. */
    handOff: (build: ClaimedBuild, runnerId: string) => Promise<void>;
    /** Identifies this tick's leases. */
    runnerId: string;
}

export interface BuildDispatchResult {
    /** The builds handed to a runner this tick, in claim order. */
    handedOff: string[];
}

/**
 * Builds one tick claims. Each runs in its own build-box container, so this is
 * the build box's `maxInstances` (`lunora/containers.ts`): claiming more would
 * only queue them on a container that is not there.
 */
export const DEFAULT_MAX_BUILDS_PER_TICK = 5;

/**
 * Claim and hand off up to `maxBuilds` builds, stopping as soon as the queue
 * drains. A build that cannot be handed off is failed with the reason rather
 * than left leased until its lease goes stale. Never throws on a hand-off.
 */
export const claimBuilds = async (ports: BuildDispatchPorts, maxBuilds: number = DEFAULT_MAX_BUILDS_PER_TICK): Promise<BuildDispatchResult> => {
    const handedOff: string[] = [];

    for (let claimed = 0; claimed < maxBuilds; claimed += 1) {
        // eslint-disable-next-line no-await-in-loop -- leases are taken one at a time, so two never name the same build
        const build = await ports.claimNext(ports.runnerId);

        if (!build) {
            break;
        }

        try {
            // eslint-disable-next-line no-await-in-loop -- the hand-off is a storage write and an alarm; claim order is kept
            await ports.handOff(build, ports.runnerId);
            handedOff.push(build.buildId);
        } catch (error) {
            // eslint-disable-next-line no-await-in-loop -- see above
            await ports
                .fail(build.buildId, `the build could not be handed to a runner: ${error instanceof Error ? error.message : String(error)}`)
                .catch(() => {});
        }
    }

    return { handedOff };
};
