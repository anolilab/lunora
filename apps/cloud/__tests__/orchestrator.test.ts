import { describe, expect, it } from "vitest";

import type { DeployProgress } from "../src/deploy/orchestrator";
import { destroyDeployment, runDeployment } from "../src/deploy/orchestrator";
import { CellScheduler } from "../src/deploy/scheduler";
import { TokenBucket } from "../src/deploy/token-bucket";
import type { Provisioner, TenantDeploymentSpec } from "../src/provision";

const spec: TenantDeploymentSpec = {
    bindings: { d1: { binding: "DB" } },
    bundle: new ArrayBuffer(8),
    cell: "cell-1",
    dispatchNamespace: "cirrus-production",
    scriptName: "org__project",
    secrets: {},
    tags: ["org:org", "project:project", "env:production"],
};

const ampleScheduler = (): CellScheduler => new CellScheduler({ bucket: new TokenBucket({ capacity: 100, refillPerWindow: 100, windowMs: 1000 }) });

describe(runDeployment, () => {
    it("emits queued → provisioning → live and returns the result on success", async () => {
        const progress: DeployProgress[] = [];
        const provisioner: Provisioner = {
            deploy: () => Promise.resolve({ bundleHash: "abc123", scriptName: "org__project", url: "https://project.cirrus.app" }),
            destroy: () => Promise.resolve(),
        };

        const outcome = await runDeployment(spec, {
            onProgress: (p) => {
                progress.push(p);
            },
            provisioner,
            scheduler: ampleScheduler(),
        });

        expect(progress.map((p) => p.phase)).toStrictEqual(["queued", "provisioning", "live"]);
        expect(outcome).toStrictEqual({ result: { bundleHash: "abc123", scriptName: "org__project", url: "https://project.cirrus.app" }, status: "live" });
        expect(progress.at(-1)).toMatchObject({ bundleHash: "abc123", url: "https://project.cirrus.app" });
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
            provisioner,
            scheduler: ampleScheduler(),
        });

        expect(progress.map((p) => p.phase)).toStrictEqual(["queued", "provisioning", "failed"]);
        expect(outcome).toStrictEqual({ error: "dispatch upload rejected", status: "failed" });
    });
});

describe(destroyDeployment, () => {
    it("calls the provisioner's destroy through the scheduler", async () => {
        const destroyed: { dispatchNamespace: string; scriptName: string }[] = [];
        const provisioner: Provisioner = {
            deploy: () => Promise.reject(new Error("unused")),
            destroy: (reference) => {
                destroyed.push(reference);

                return Promise.resolve();
            },
        };

        await destroyDeployment({ dispatchNamespace: "cirrus-preview", scriptName: "org__project" }, { provisioner, scheduler: ampleScheduler() });

        expect(destroyed).toStrictEqual([{ dispatchNamespace: "cirrus-preview", scriptName: "org__project" }]);
    });
});
