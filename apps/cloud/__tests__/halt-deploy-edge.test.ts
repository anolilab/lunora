import { describe, expect, it, vi } from "vitest";

import { HALTED_REFUSAL } from "../src/deploy/halt";
import { handleDeployRequest } from "../src/deploy/handler";
import { createDeployPacer } from "../src/deploy/pacing";
import type { DeployBackend } from "../src/deploy/release-core";
import { refuseHaltedConverge } from "../src/deploy/routes/deploy";
import type { LunoraActionContext } from "../src/deploy/routes/shared";
import type { TenantDeploymentSpec } from "../src/provision-contract";
import memoryReleaseStore from "./_helpers/memory-release-store";
import { fakeDriver } from "./support/memory-driver";

/**
 * The deploy edge's last check before anything lands on an alias's Worker
 * (`refuseHaltedConverge`): a deploy, revert or rollback already queued when
 * an emergency stop was asked for must not land on top of the stub. The
 * up-front refusals (`deployments.create`, `releaseTarget`, `rollback`) are in
 * `halts-functions.test.ts`; this is the converge-time one, on the real deploy core.
 */

/** A Lunora context whose `halts.aliasHalted` answers from `halted`. */
const contextOf = (halted: Set<string>): LunoraActionContext => {
    return {
        runAction: async () => undefined as never,
        runMutation: async () => undefined as never,
        runQuery: async <R>(_reference: unknown, args?: Record<string, unknown>) => halted.has(String(args?.["alias"])) as R,
    };
};

const capture = () => {
    const deployed: string[] = [];
    const deploy = vi.fn<(spec: TenantDeploymentSpec) => Promise<{ url: string }>>(async (spec) => {
        deployed.push(new TextDecoder().decode(spec.bundle));

        return { url: `https://${spec.alias}.lunora.app` };
    });

    return { deploy, deployed };
};

const backend = (overrides: Partial<DeployBackend> = {}): DeployBackend => {
    return {
        createDeployment: async () => {
            return { deploymentId: "dep_new", previousDeploymentId: "dep_prev", version: 2 };
        },
        placement: async () => {
            return { target: "cloudflare-wfp" };
        },
        releaseTarget: async () => {
            return {
                adminToken: "admin-prev",
                alias: "app",
                kind: "production",
                organizationId: "org_1",
                projectId: "proj_1",
                target: "cloudflare-wfp",
            };
        },
        rollbackDeployment: async () => {
            return { scriptName: "app", version: 1 };
        },
        updateStatus: async () => undefined,
        verifyKey: async () => {
            return { organizationId: "org_1", projectId: "proj_1", type: "production" as const };
        },
        ...overrides,
    };
};

const deployRequest = (): Request =>
    new Request("https://cloud/v1/deploy", {
        body: JSON.stringify({ bundle: btoa("export default { v: 2 }"), projectId: "proj_1", scriptName: "app" }),
        headers: { authorization: "Bearer k", "content-type": "application/json" },
        method: "POST",
    });

const lines = async (response: Response): Promise<Record<string, unknown>[]> => {
    const text = await response.text();

    return text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
};

describe(refuseHaltedConverge, () => {
    it("refuses to converge onto a halted alias, and passes any other through", async () => {
        const { deploy } = capture();
        const driver = refuseHaltedConverge(contextOf(new Set(["app"])), fakeDriver({ deploy }));
        const spec = (alias: string): TenantDeploymentSpec => {
            return { alias, bundle: new ArrayBuffer(0), deploymentId: "d", kind: "production", manifest: { bindings: [] }, secrets: {}, tags: [] };
        };

        await expect(driver.deploy(spec("app"))).rejects.toThrow(HALTED_REFUSAL);
        expect(deploy).not.toHaveBeenCalled();
        await expect(driver.deploy(spec("other"))).resolves.toStrictEqual({ url: "https://other.lunora.app" });
    });

    it("fails a deploy whose converge comes up after the halt, before anything reaches the Worker", async () => {
        const { deploy, deployed } = capture();
        const response = await handleDeployRequest(deployRequest(), {
            backend: backend(),
            driverFor: () => refuseHaltedConverge(contextOf(new Set(["app"])), fakeDriver({ deploy })),
            pacer: createDeployPacer(),
            releases: memoryReleaseStore().store,
        });
        const frames = await lines(response);

        expect(deployed).toStrictEqual([]);
        expect(frames).toContainEqual(expect.objectContaining({ error: HALTED_REFUSAL, phase: "failed" }));
        // It never reached the Worker, so there is nothing to revert — and nothing tries.
        expect(frames.some((frame) => String(frame["event"]).includes("revert"))).toBe(false);
    });

    it("never lets a failed health check's revert land on the stub", async () => {
        const { deploy, deployed } = capture();
        const halted = new Set<string>();
        const { store } = memoryReleaseStore();

        await store.put("dep_prev", { bundle: btoa("export default { v: 1 }"), manifest: { bindings: [] } });

        const response = await handleDeployRequest(deployRequest(), {
            backend: backend(),
            driverFor: () => refuseHaltedConverge(contextOf(halted), fakeDriver({ deploy })),
            // The halt is asked for, and its stub converged, while the release is being verified: the dispatcher answers 503.
            healthCheck: async () => {
                halted.add("app");
                deployed.push("export default { halted: true }");

                return false;
            },
            pacer: createDeployPacer(),
            releases: store,
        });
        const frames = await lines(response);

        expect(deployed).toStrictEqual(["export default { v: 2 }", "export default { halted: true }"]);
        expect(frames).toContainEqual(expect.objectContaining({ error: HALTED_REFUSAL, event: "revert_failed", to: "dep_prev" }));
        expect(frames.at(-1)).toMatchObject({ done: true, status: "failed" });
    });
});
