import { describe, expect, it } from "vitest";

import { sha256HexBytes } from "../src/deploy/keys";
import type { DeployProgress } from "../src/deploy/orchestrator";
import { runDeployment } from "../src/deploy/orchestrator";
import { ConvergeScheduler } from "../src/deploy/scheduler";
import { TokenBucket } from "../src/deploy/token-bucket";
import type { TenantDeploymentSpec } from "../src/provision-contract";
import type { TargetDriver } from "../src/targets/driver";

type Provisioner = Pick<TargetDriver, "deploy">;

const spec: TenantDeploymentSpec = {
    alias: "org__project",
    bundle: new ArrayBuffer(8),
    deploymentId: "dep_1",
    kind: "production",
    manifest: { bindings: [{ binding: "DB", type: "d1" }] },
    secrets: {},
    tags: ["org:org", "project:project", "env:production"],
};

const ampleScheduler = (): ConvergeScheduler => new ConvergeScheduler({ bucket: new TokenBucket({ capacity: 100, refillPerWindow: 100, windowMs: 1000 }) });

describe(runDeployment, () => {
    it("emits queued → provisioning → live and returns the result on success", async () => {
        const progress: DeployProgress[] = [];
        const provisioner: Provisioner = {
            deploy: () => Promise.resolve({ url: "https://project.lunora.app" }),
        };

        const outcome = await runDeployment(spec, {
            onProgress: (p) => {
                progress.push(p);
            },
            driver: provisioner,
            scheduler: ampleScheduler(),
        });

        const bundleHash = await sha256HexBytes(spec.bundle);

        expect(progress.map((p) => p.phase)).toStrictEqual(["queued", "provisioning", "live"]);
        expect(outcome).toStrictEqual({ result: { bundleHash, url: "https://project.lunora.app" }, status: "live" });
        expect(progress.at(-1)).toMatchObject({ bundleHash, url: "https://project.lunora.app" });
    });

    it("hashes the bundle it converged, whatever the target: a new release reports a new hash", async () => {
        const provisioner: Provisioner = { deploy: () => Promise.resolve({ url: "https://project.lunora.app" }) };
        const release = async (source: string) => {
            const outcome = await runDeployment(
                { ...spec, bundle: new TextEncoder().encode(source).buffer },
                { driver: provisioner, scheduler: ampleScheduler() },
            );

            return outcome.status === "live" ? outcome.result.bundleHash : undefined;
        };

        const first = await release("export default { version: 1 }");

        expect(first).toBe(await release("export default { version: 1 }"));
        await expect(release("export default { version: 2 }")).resolves.not.toBe(first);
    });

    it("hands the target's own progress lines to onLine", async () => {
        const lines: string[] = [];
        const provisioner: Provisioner = {
            deploy: (_spec, options) => {
                options?.onProgress?.("fetching release");

                return Promise.resolve({ url: "https://project.lunora.app" });
            },
        };

        await runDeployment(spec, { driver: provisioner, onLine: (line) => lines.push(line), scheduler: ampleScheduler() });

        expect(lines).toStrictEqual(["fetching release"]);
    });

    it("emits a failed event and surfaces the error message when provisioning throws", async () => {
        const progress: DeployProgress[] = [];
        const provisioner: Provisioner = {
            deploy: () => Promise.reject(new Error("dispatch upload rejected")),
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
            deploy: () => Promise.resolve({ url: "https://project.lunora.app" }),
        };

        const outcome = await runDeployment(spec, { driver: provisioner, scheduler: ampleScheduler(), verify: () => Promise.resolve(false) });

        expect(outcome).toStrictEqual({ error: "health check failed", provisioned: true, status: "failed" });
    });
});
