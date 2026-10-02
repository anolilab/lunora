import type { TenantDeploymentSpec } from "../provision-contract";
import type { ProgressLine, TargetDriver } from "../targets/driver";
import { sha256HexBytes } from "./keys";
import type { CellScheduler } from "./scheduler";

/**
 * Deploy orchestrator. Drives a single tenant deployment
 * through its lifecycle and emits progress events (the platform's NDJSON/SSE
 * stream + the `deployments.updateStatus` mutation both consume these). The
 * bundle is prebuilt by the app's Vite pipeline, so "building" is the client's
 * concern; the platform's phases are queued → provisioning → live / failed.
 *
 * The converge is paced through the cell's {@link CellScheduler} and executed by
 * the project's {@link TargetDriver}. Both are injected, so a deployment can be
 * driven end-to-end in tests with a fake driver.
 */

export type DeployPhase = "failed" | "live" | "provisioning" | "queued" | "verifying";

export interface DeployProgress {
    bundleHash?: string;
    error?: string;
    phase: DeployPhase;
    url?: string;
}

/** A release that is serving: where, and which bundle. */
export interface DeployedRelease {
    /** SHA-256 of the bundle now serving — hashed here, once, whatever the target. */
    bundleHash: string;
    url: string;
}

export interface RunDeploymentOptions {
    /** The project's target driver — only its converge half is used here. */
    driver: Pick<TargetDriver, "deploy">;
    /** The target's own progress lines while it converges (a box's job output). */
    onLine?: ProgressLine;
    /** Reports each phase transition (NDJSON event / status patch). */
    onProgress?: (progress: DeployProgress) => Promise<void> | void;
    /** Priority for the cell scheduler (interactive deploy > preview > cleanup). */
    priority?: number;
    scheduler: CellScheduler;

    /**
     * Health check the project's Worker once the release is on it (GAPS.md A1).
     *
     * This runs AFTER cutover: the project has one stable script, so the release
     * is already serving 100% of traffic when it is probed. Returning `false`
     * fails the deployment with `provisioned: true`, which tells the caller the
     * broken code is live and the previous release must be re-provisioned.
     * Omit to skip verification.
     */
    verify?: (url: string) => Promise<boolean>;
}

/**
 * `provisioned` says whether the failed release reached the tenant: true only
 * for a failed health check. A converge failure leaves the tenant on the
 * previous release (every driver makes the cut-over its last, atomic step).
 */
export type DeployOutcome = { error: string; provisioned: boolean; status: "failed" } | { result: DeployedRelease; status: "live" };

export const runDeployment = async (spec: TenantDeploymentSpec, options: RunDeploymentOptions): Promise<DeployOutcome> => {
    const emit = async (progress: DeployProgress): Promise<void> => {
        await options.onProgress?.(progress);
    };

    await emit({ phase: "queued" });
    await emit({ phase: "provisioning" });

    try {
        const [bundleHash, { url }] = await Promise.all([
            sha256HexBytes(spec.bundle),
            options.scheduler.run(() => options.driver.deploy(spec, options.onLine === undefined ? {} : { onProgress: options.onLine }), {
                priority: options.priority,
            }),
        ]);
        const result: DeployedRelease = { bundleHash, url };

        if (options.verify) {
            await emit({ phase: "verifying", url: result.url });

            const healthy = await options.verify(result.url);

            if (!healthy) {
                await emit({ error: "health check failed", phase: "failed", url: result.url });

                return { error: "health check failed", provisioned: true, status: "failed" };
            }
        }

        await emit({ bundleHash: result.bundleHash, phase: "live", url: result.url });

        return { result, status: "live" };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        await emit({ error: message, phase: "failed" });

        return { error: message, provisioned: false, status: "failed" };
    }
};
