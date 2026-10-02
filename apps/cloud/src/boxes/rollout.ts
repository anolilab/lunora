/**
 * Rolling a `lunora-hostd` release out across boxes (plan 458 W7, G17) — the
 * first production caller of the fleet-upgrade planner (`src/fleet/upgrade.ts`).
 *
 * A box is "on" a release when it reports that release's three versions. The
 * planner canaries one box, then upgrades in batches, and halts the moment the
 * failure rate breaks its threshold — everything not yet attempted keeps
 * running what it runs. Each upgrade is an `upgrade` job over the box's
 * session; the box fetches the signed manifest itself, verifies it against the
 * keys compiled into it, and restarts onto the new binaries.
 *
 * Only boxes online right now are planned. The rest already have
 * `desiredReleaseId` set, and their session hands them the upgrade the moment
 * they authenticate (`BoxSessionDO`), so a box that is down misses nothing.
 */
import type { UpgradeJob } from "@lunora/hostd/protocol";

import type { FleetUpgradeResult } from "../fleet/upgrade";
import { planFleetUpgrade, runFleetUpgrade } from "../fleet/upgrade";
import type { ReleaseVersions } from "./hostd-releases";
import { versionKey } from "./hostd-releases";
import type { JobOutcome } from "./jobs";

export interface RolloutTarget {
    boxId: string;
    status: string;
    versions?: ReleaseVersions;
}

export interface RolloutResult extends FleetUpgradeResult {
    /** Boxes not online now: they upgrade when they next connect. */
    deferred: number;
    /** Boxes already on the release. */
    skipped: number;
}

export const rolloutHostdRelease = async (input: {
    batchSize?: number;
    boxes: ReadonlyArray<RolloutTarget>;
    canarySize?: number;
    /** Run one job on one box; a refusal (offline, busy) is a failed upgrade, not an error. */
    dispatch: (boxId: string, job: UpgradeJob) => Promise<JobOutcome>;
    manifestUrl: string;
    maxFailureRate?: number;
    release: { releaseId: string; versions: ReleaseVersions };
}): Promise<RolloutResult> => {
    const online = input.boxes.filter((box) => box.status === "online");
    const plan = planFleetUpgrade({
        ...(input.batchSize === undefined ? {} : { batchSize: input.batchSize }),
        ...(input.canarySize === undefined ? {} : { canarySize: input.canarySize }),
        // One "deployment" per box: the planner's unit is whatever is upgraded one at a time.
        deployments: online.map((box) => {
            return { deploymentId: box.boxId, projectId: box.boxId, ...(box.versions === undefined ? {} : { runtimeVersion: versionKey(box.versions) }) };
        }),
        targetVersion: versionKey(input.release.versions),
    });
    const job: UpgradeJob = { kind: "upgrade", manifestUrl: input.manifestUrl, releaseId: input.release.releaseId };
    const result = await runFleetUpgrade(plan, {
        ...(input.maxFailureRate === undefined ? {} : { maxFailureRate: input.maxFailureRate }),
        release: async (box) => {
            const outcome = await input.dispatch(box.deploymentId, job);

            return outcome.ok;
        },
    });

    return { ...result, deferred: input.boxes.length - online.length, skipped: plan.skipped };
};
