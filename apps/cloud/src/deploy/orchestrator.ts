import type { Provisioner, ProvisionResult, TenantDeploymentSpec } from "../provision";
import type { CellScheduler } from "./scheduler";

/**
 * Deploy orchestrator (CLOUD-PLAN.md §2.2). Drives a single tenant deployment
 * through its lifecycle and emits progress events (the platform's NDJSON/SSE
 * stream + the `deployments.updateStatus` mutation both consume these). The
 * bundle is prebuilt by the app's Vite pipeline, so "building" is the client's
 * concern; the platform's phases are queued → provisioning → live / failed.
 *
 * The actual Cloudflare work is paced through the cell's {@link CellScheduler}
 * and executed by the {@link Provisioner} (Alchemy v2). Both are injected, so a
 * deployment can be driven end-to-end in tests with a fake provisioner.
 */

export type DeployPhase = "failed" | "live" | "provisioning" | "queued" | "verifying";

export interface DeployProgress {
    bundleHash?: string;
    error?: string;
    phase: DeployPhase;
    url?: string;
}

export interface RunDeploymentOptions {
    /** Reports each phase transition (NDJSON event / status patch). */
    onProgress?: (progress: DeployProgress) => Promise<void> | void;
    /** Priority for the cell scheduler (interactive deploy > preview > cleanup). */
    priority?: number;
    provisioner: Provisioner;
    scheduler: CellScheduler;
    // Health check the freshly uploaded (versioned) script before it is
    // declared live (GAPS.md A1). Returning `false` fails the deployment — the
    // previously active version keeps serving; the pointer is never touched.
    // Omit to skip verification (previews/dev).
    verify?: (result: ProvisionResult) => Promise<boolean>;
}

export type DeployOutcome = { error: string; status: "failed" } | { result: ProvisionResult; status: "live" };

export const runDeployment = async (spec: TenantDeploymentSpec, options: RunDeploymentOptions): Promise<DeployOutcome> => {
    const emit = async (progress: DeployProgress): Promise<void> => {
        await options.onProgress?.(progress);
    };

    await emit({ phase: "queued" });
    await emit({ phase: "provisioning" });

    try {
        const result = await options.scheduler.run(() => options.provisioner.deploy(spec), { priority: options.priority });

        if (options.verify) {
            await emit({ phase: "verifying", url: result.url });

            const healthy = await options.verify(result);

            if (!healthy) {
                await emit({ error: "health check failed", phase: "failed", url: result.url });

                return { error: "health check failed", status: "failed" };
            }
        }

        await emit({ bundleHash: result.bundleHash, phase: "live", url: result.url });

        return { result, status: "live" };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        await emit({ error: message, phase: "failed" });

        return { error: message, status: "failed" };
    }
};

/**
 * Tear a deployment down through the same paced path (preview TTL cleanup,
 * project deletion). Lower default priority than a deploy.
 */
export const destroyDeployment = async (
    reference: { dispatchNamespace: string; scriptName: string },
    options: { priority?: number; provisioner: Provisioner; scheduler: CellScheduler },
): Promise<void> => {
    await options.scheduler.run(() => options.provisioner.destroy(reference), { priority: options.priority ?? -1 });
};
