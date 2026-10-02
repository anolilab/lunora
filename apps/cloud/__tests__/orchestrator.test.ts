import { describe, expect, it } from "vitest";

import type { DeployProgress } from "../src/deploy/orchestrator";
import { destroyDeployment, runDeployment } from "../src/deploy/orchestrator";
import { CellScheduler } from "../src/deploy/scheduler";
import { TokenBucket } from "../src/deploy/token-bucket";
import type { TenantDeploymentSpec } from "../src/provision-contract";
import type { DestroyRef, TargetDriver } from "../src/targets/driver";

type Provisioner = Pick<TargetDriver, "deploy" | "destroy">;

const spec: TenantDeploymentSpec = {
    alias: "org__project",
    bundle: new ArrayBuffer(8),
    deploymentId: "dep_1",
    kind: "production",
    manifest: { bindings: [{ binding: "DB", type: "d1" }] },
    secrets: {},
    tags: ["org:org", "project:project", "env:production"],
};

const ampleScheduler = (): CellScheduler => new CellScheduler({ bucket: new TokenBucket({ capacity: 100, refillPerWindow: 100, windowMs: 1000 }) });

describe(runDeployment, () => {
    it("emits queued → provisioning → live and returns the result on success", async () => {
        const progress: DeployProgress[] = [];
        const provisioner: Provisioner = {
            deploy: () => Promise.resolve({ bundleHash: "abc123", url: "https://project.lunora.app" }),
            destroy: () => Promise.resolve(),
        };

        const outcome = await runDeployment(spec, {
            onProgress: (p) => {
                progress.push(p);
            },
            driver: provisioner,
            scheduler: ampleScheduler(),
        });

        expect(progress.map((p) => p.phase)).toStrictEqual(["queued", "provisioning", "live"]);
        expect(outcome).toStrictEqual({ result: { bundleHash: "abc123", url: "https://project.lunora.app" }, status: "live" });
        expect(progress.at(-1)).toMatchObject({ bundleHash: "abc123", url: "https://project.lunora.app" });
    });

    it("emits a failed event and surfaces the error message when provisioning throws", async () => {
        const progress: DeployProgress[] = [];
        const provisioner: Provisioner = {
            deploy: () => Promise.reject(new Error("dispatch upload rejected")),
            destroy: () => Promise.resolve(),
        };

        const outcome = await runDeployment(spec, {
            onProgress: (p) => {
                progress.push(p);
            },
            driver: provisioner,
            scheduler: ampleScheduler(),
        });

        expect(progress.map((p) => p.phase)).toStrictEqual(["queued", "provisioning", "failed"]);
        // The box never reached the Worker, so there is nothing live to revert.
        expect(outcome).toStrictEqual({ error: "dispatch upload rejected", provisioned: false, status: "failed" });
    });

    it("reports a failed health check as provisioned — the release is already on the Worker", async () => {
        const provisioner: Provisioner = {
            deploy: () => Promise.resolve({ bundleHash: "abc123", url: "https://project.lunora.app" }),
            destroy: () => Promise.resolve(),
        };

        const outcome = await runDeployment(spec, { driver: provisioner, scheduler: ampleScheduler(), verify: () => Promise.resolve(false) });

        expect(outcome).toStrictEqual({ error: "health check failed", provisioned: true, status: "failed" });
    });
});

describe(destroyDeployment, () => {
    it("calls the driver's destroy through the scheduler", async () => {
        const destroyed: DestroyRef[] = [];
        const target: DestroyRef = { alias: "org__project" };
        const provisioner: Provisioner = {
            deploy: () => Promise.reject(new Error("unused")),
            destroy: (reference) => {
                destroyed.push(reference);

                return Promise.resolve();
            },
        };

        await destroyDeployment(target, { driver: provisioner, scheduler: ampleScheduler() });

        expect(destroyed).toStrictEqual([target]);
    });
});
