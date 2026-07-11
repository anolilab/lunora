/**
 * Fleet runtime re-release (GAPS.md E4, the operational answer to fat tenant
 * workers). A runtime security patch becomes a paced batch job over the
 * existing machinery: rebuild each stale project (A3 server-side builds),
 * release it as a new immutable version behind the health gate (A1), and let
 * the pointer swap do the cutover — a failed release leaves that tenant on the
 * old-but-serving version. Pure over an injected `release` port; the runner
 * canaries the first batch and halts the fleet when the failure rate breaks
 * the threshold, so a bad runtime never ships past its canary.
 */

export interface FleetDeployment {
    deploymentId: string;
    projectId: string; // secret-scanner:allow -- domain field name
    /** Runtime version currently live for this project (absent = unknown/oldest). */
    runtimeVersion?: string;
}

export interface FleetUpgradePlan {
    batches: FleetDeployment[][];
    skipped: number;
    targetVersion: string;
}

export interface PlanOptions {
    /** Per-batch size after the canary. Default 25 (stays inside the API budget with headroom). */
    batchSize?: number;
    /** Canary size for batch one. Default 1. */
    canarySize?: number;
    deployments: ReadonlyArray<FleetDeployment>;
    targetVersion: string;
}

/**
 * Plan a fleet upgrade: dedupe to one deployment per project (the live one is
 * passed in), skip projects already on the target, canary first, then even
 * batches. Deterministic order (by projectId) so a halted run resumes stably.
 */
export const planFleetUpgrade = (options: PlanOptions): FleetUpgradePlan => {
    const batchSize = options.batchSize ?? 25;
    const canarySize = options.canarySize ?? 1;
    const seen = new Set<string>();
    const stale: FleetDeployment[] = [];
    let skipped = 0;

    for (const deployment of options.deployments.toSorted((a, b) => a.projectId.localeCompare(b.projectId))) {
        if (seen.has(deployment.projectId)) {
            continue;
        }

        seen.add(deployment.projectId);

        if (deployment.runtimeVersion === options.targetVersion) {
            skipped += 1;
        } else {
            stale.push(deployment);
        }
    }

    const batches: FleetDeployment[][] = [];

    if (stale.length > 0) {
        batches.push(stale.slice(0, canarySize));

        for (let index = canarySize; index < stale.length; index += batchSize) {
            batches.push(stale.slice(index, index + batchSize));
        }
    }

    return { batches, skipped, targetVersion: options.targetVersion };
};

export interface RunOptions {
    /** Halt the run when the cumulative failure rate exceeds this (0..1). Default 0.1. */
    maxFailureRate?: number;
    onProgress?: (progress: { batch: number; failed: number; released: number }) => void;

    /**
     * Rebuild + release one project on the target runtime (build → deploy →
     * health gate → pointer swap). Resolve `true` on a successful cutover;
     * `false`/throw counts as a failure (the tenant stays on its old version).
     */
    release: (deployment: FleetDeployment, targetVersion: string) => Promise<boolean>;
}

export interface FleetUpgradeResult {
    failed: number;
    halted: boolean;
    released: number;
    remaining: number;
}

/**
 * Drive a planned upgrade batch by batch. The canary batch must be fully
 * clean to proceed; afterwards the run halts as soon as the cumulative
 * failure rate crosses the threshold — everything not yet attempted stays on
 * its current (still-serving) version.
 */
export const runFleetUpgrade = async (plan: FleetUpgradePlan, options: RunOptions): Promise<FleetUpgradeResult> => {
    const maxFailureRate = options.maxFailureRate ?? 0.1;
    let released = 0;
    let failed = 0;
    let attempted = 0;

    for (const [batchIndex, batch] of plan.batches.entries()) {
        // eslint-disable-next-line no-await-in-loop -- batches are sequential by design: each gates the next on failure rate
        const outcomes = await Promise.all(
            batch.map(async (deployment) => {
                try {
                    return await options.release(deployment, plan.targetVersion);
                } catch {
                    return false;
                }
            }),
        );

        released += outcomes.filter(Boolean).length;
        failed += outcomes.filter((outcome) => !outcome).length;
        attempted += batch.length;
        options.onProgress?.({ batch: batchIndex + 1, failed, released });

        const canaryDirty = batchIndex === 0 && failed > 0;

        if (canaryDirty || failed / attempted > maxFailureRate) {
            const remaining = plan.batches.slice(batchIndex + 1).reduce((sum, rest) => sum + rest.length, 0);

            return { failed, halted: true, released, remaining };
        }
    }

    return { failed, halted: false, released, remaining: 0 };
};
