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
 * The durable intent is `boxes.desiredReleaseId`, set before anything runs:
 *
 * - `POST /v1/hostd/rollout` plans, answers 202 with the batches, and starts
 *   the run on the request's `waitUntil` — which the runtime ends about 30 s
 *   after the response, long before a fleet of 15-minute upgrades is through.
 * - So the hourly scheduled sweep ({@link resumeHostdRollouts}) re-plans every
 *   release some box still desires and runs it again, from a cron invocation
 *   (15 minutes of wall time). The planner skips boxes already on the release,
 *   so a re-run picks up exactly where the last one stopped, canary first.
 * - A box that is offline is not planned: its session hands it the upgrade the
 *   moment it authenticates (`BoxSessionDO`).
 * - A halted run withdraws the intent from every box of the release it did not
 *   upgrade, so neither the sweep nor a reconnect spreads a release that failed
 *   its canary. Rolling it out again is a new `POST /v1/hostd/rollout`.
 */
import type { UpgradeJob } from "@lunora/hostd/protocol";

import type { ControlPlaneStore } from "../d1-store";
import type { FleetUpgradePlan, FleetUpgradeResult } from "../fleet/upgrade";
import { planFleetUpgrade, runFleetUpgrade } from "../fleet/upgrade";
import stripTrailingSlashes from "../lib/strip-trailing-slashes";
import { drainTable } from "../store";
import type { ReleaseVersions } from "./hostd-releases";
import { versionKey } from "./hostd-releases";
import type { JobOutcome } from "./jobs";
import type { BoxSessionNamespace } from "./session-client";
import { boxSession } from "./session-client";

/** How long one box may take to download, verify and restart onto a release. */
const UPGRADE_TIMEOUT_MS = 15 * 60 * 1000;

/** Where a box fetches a release's signed envelope. */
export const manifestUrlOf = (origin: string, releaseId: string): string =>
    `${stripTrailingSlashes(origin)}/v1/hostd/releases/${encodeURIComponent(releaseId)}/manifest`;

/** Run an `upgrade` job over a box's session; a refusal before the box saw it is a failed upgrade. */
export const upgradeDispatch =
    (namespace: BoxSessionNamespace) =>
    (boxId: string, job: UpgradeJob): Promise<JobOutcome> =>
        boxSession(namespace, boxId)
            .dispatch(job, { timeoutMs: UPGRADE_TIMEOUT_MS })
            .catch((error: unknown) => {
                return { error: { code: "DISPATCH_FAILED", message: error instanceof Error ? error.message : String(error) }, ok: false };
            });

export interface RolloutTarget {
    boxId: string;
    status: string;
    versions?: ReleaseVersions;
}

/** A planned rollout: what {@link runHostdRollout} executes, and what the route answers. */
export interface PlannedRollout {
    /** Box ids, canary batch first. */
    batches: string[][];
    /** Boxes not online now: they upgrade when they next connect. */
    deferred: number;
    job: UpgradeJob;
    plan: FleetUpgradePlan;
    /** Boxes already on the release. */
    skipped: number;
    /** Every box of the rollout not yet on the release — whose intent a halt withdraws. */
    stale: string[];
}

export interface RolloutResult extends FleetUpgradeResult {
    /** Boxes whose `desiredReleaseId` a halt cleared. */
    withdrawn: number;
}

export const planHostdRollout = (input: {
    batchSize?: number;
    boxes: ReadonlyArray<RolloutTarget>;
    canarySize?: number;
    manifestUrl: string;
    release: { releaseId: string; versions: ReleaseVersions };
}): PlannedRollout => {
    const target = versionKey(input.release.versions);
    const online = input.boxes.filter((box) => box.status === "online");
    const plan = planFleetUpgrade({
        ...(input.batchSize === undefined ? {} : { batchSize: input.batchSize }),
        ...(input.canarySize === undefined ? {} : { canarySize: input.canarySize }),
        // One "deployment" per box: the planner's unit is whatever is upgraded one at a time.
        deployments: online.map((box) => {
            return { deploymentId: box.boxId, projectId: box.boxId, ...(box.versions === undefined ? {} : { runtimeVersion: versionKey(box.versions) }) };
        }),
        targetVersion: target,
    });

    return {
        batches: plan.batches.map((batch) => batch.map((box) => box.deploymentId)),
        deferred: input.boxes.length - online.length,
        job: { kind: "upgrade", manifestUrl: input.manifestUrl, releaseId: input.release.releaseId },
        plan,
        skipped: plan.skipped,
        stale: input.boxes.filter((box) => box.versions === undefined || versionKey(box.versions) !== target).map((box) => box.boxId),
    };
};

/** Execute a planned rollout; on a halt, withdraw the intent from every box it did not upgrade. */
export const runHostdRollout = async (
    planned: PlannedRollout,
    ports: {
        /** Run one job on one box; a refusal (offline, busy) is a failed upgrade, not an error. */
        dispatch: (boxId: string, job: UpgradeJob) => Promise<JobOutcome>;
        maxFailureRate?: number;
        /** Clear `desiredReleaseId` on these boxes, where it still names this release. */
        withdraw: (boxIds: string[]) => Promise<void>;
    },
): Promise<RolloutResult> => {
    const upgraded = new Set<string>();
    const result = await runFleetUpgrade(planned.plan, {
        ...(ports.maxFailureRate === undefined ? {} : { maxFailureRate: ports.maxFailureRate }),
        release: async (box) => {
            const outcome = await ports.dispatch(box.deploymentId, planned.job);

            if (outcome.ok) {
                upgraded.add(box.deploymentId);
            }

            return outcome.ok;
        },
    });

    if (!result.halted) {
        return { ...result, withdrawn: 0 };
    }

    const withdrawn = planned.stale.filter((boxId) => !upgraded.has(boxId));

    await ports.withdraw(withdrawn);

    return { ...result, withdrawn: withdrawn.length };
};

/** A {@link runHostdRollout} `withdraw` port over the control-plane store: clears the intent only where it still names `releaseId`. */
export const withdrawDesiredRelease =
    (database: ControlPlaneStore, releaseId: string) =>
    async (boxIds: string[]): Promise<void> => {
        for (const boxId of boxIds) {
            // eslint-disable-next-line no-await-in-loop -- re-read per box: a newer rollout may have re-pointed it since
            const row = (await database.get(boxId, "boxes")) as null | { desiredReleaseId?: null | string };

            if (row?.desiredReleaseId === releaseId) {
                // eslint-disable-next-line no-await-in-loop -- see above
                await database.patch(boxId, { desiredReleaseId: null }, "boxes");
            }
        }
    };

interface DesiringBoxRow {
    _id: string;
    desiredReleaseId?: null | string;
    status: string;
    versions?: null | ReleaseVersions;
}

/**
 * The scheduled continuation: re-plan and run every release a box that is not
 * revoked still desires. Idempotent — boxes already on their release are
 * skipped, and a release with nothing online left to upgrade runs nothing.
 */
export const resumeHostdRollouts = async (ports: {
    database: ControlPlaneStore;
    dispatch: (boxId: string, job: UpgradeJob) => Promise<JobOutcome>;
    manifestUrlFor: (releaseId: string) => string;
}): Promise<Record<string, RolloutResult>> => {
    const rows = await drainTable<DesiringBoxRow>(ports.database, "boxes");
    const byRelease = new Map<string, RolloutTarget[]>();

    for (const row of rows) {
        if (row.status !== "revoked" && row.desiredReleaseId != null) {
            byRelease.set(row.desiredReleaseId, [
                ...(byRelease.get(row.desiredReleaseId) ?? []),
                { boxId: row._id, status: row.status, ...(row.versions == null ? {} : { versions: row.versions }) },
            ]);
        }
    }

    const results: Record<string, RolloutResult> = {};

    for (const [releaseId, boxes] of byRelease) {
        // eslint-disable-next-line no-await-in-loop -- one release at a time; rarely more than one is in flight
        const { page } = await ports.database.findMany("hostdReleases", { where: { releaseId } });
        const release = page[0] as undefined | { releaseId: string; versions: ReleaseVersions };

        if (release === undefined) {
            continue;
        }

        const planned = planHostdRollout({ boxes, manifestUrl: ports.manifestUrlFor(releaseId), release });

        if (planned.batches.length > 0) {
            // eslint-disable-next-line no-await-in-loop -- see above
            results[releaseId] = await runHostdRollout(planned, { dispatch: ports.dispatch, withdraw: withdrawDesiredRelease(ports.database, releaseId) });
        }
    }

    return results;
};
