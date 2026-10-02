import { describe, expect, it, vi } from "vitest";

import type { DeployBackend, DeployHandlerDeps } from "../src/deploy/handler";
import { handleDeployRequest } from "../src/deploy/handler";
import { runDeployment } from "../src/deploy/orchestrator";
import type { ReleaseTarget } from "../src/deploy/release";
import { rollbackRelease } from "../src/deploy/release";
import type { StoredRelease } from "../src/deploy/release-store";
import { CellScheduler } from "../src/deploy/scheduler";
import { TokenBucket } from "../src/deploy/token-bucket";
import type { TenantDeploymentSpec } from "../src/provision-contract";
import { resolveTenant } from "../src/targets/cloudflare-wfp/route";
import type { TargetDriver } from "../src/targets/driver";
import memoryReleaseStore from "./_helpers/memory-release-store";
import { fakeDriver } from "./support/memory-driver";

type Provisioner = Pick<TargetDriver, "deploy" | "destroy">;

/**
 * The release flow on a project's ONE stable Worker (GAPS.md A1): every deploy
 * and rollback converges the same tenant (the alias) on the project's target, so its
 * Durable Object data persists; releases are stored payloads; a failed health
 * check — which runs after cutover — puts the previous release back.
 */

const BUNDLE = btoa("export default { v: 2 }");
const PREVIOUS: StoredRelease = {
    bundle: btoa("export default { v: 1 }"),
    manifest: { bindings: [{ binding: "SHARD", className: "ShardDO", sqlite: true, type: "durable_object" }] },
};

const scheduler = (): CellScheduler => new CellScheduler({ bucket: new TokenBucket({ capacity: 100, refillPerWindow: 100, windowMs: 1000 }) });

/** A converge half that records every spec, with its bundle decoded. */
const capture = (): { deployed: { bundle: string; spec: TenantDeploymentSpec }[]; provisioner: Provisioner } => {
    const deployed: { bundle: string; spec: TenantDeploymentSpec }[] = [];

    return {
        deployed,
        provisioner: {
            deploy: (spec) => {
                deployed.push({ bundle: new TextDecoder().decode(spec.bundle), spec });

                return Promise.resolve({ bundleHash: "h", url: `https://${spec.alias}.lunora.app` });
            },
            destroy: () => Promise.resolve(),
        },
    };
};

const request = (body: unknown): Request =>
    new Request("https://cloud/v1/deploy", {
        body: JSON.stringify(body),
        headers: { authorization: "Bearer k", "content-type": "application/json" },
        method: "POST",
    });

const releaseTarget = (overrides: Partial<ReleaseTarget> = {}): ReleaseTarget => {
    return { adminToken: "admin-prev", alias: "app", kind: "production", organizationId: "org_1", projectId: "proj_1", target: "cloudflare-wfp", ...overrides };
};

const backendWith = (overrides: Partial<DeployBackend>): DeployBackend => {
    return {
        createDeployment: () => Promise.resolve({ deploymentId: "dep_new", version: 2 }),
        placement: () => Promise.resolve({ target: "cloudflare-wfp" }),
        releaseTarget: () => Promise.resolve(releaseTarget()),
        rollbackDeployment: () => Promise.resolve({ scriptName: "app", version: 1 }),
        updateStatus: () => Promise.resolve(),
        verifyKey: () => Promise.resolve({ organizationId: "org_1", projectId: "proj_1", type: "production" as const }),
        ...overrides,
    };
};

/** Deploy deps whose every target resolves to `provisioner` (a fresh capturing one by default). */
const deps = (
    backend: DeployBackend,
    { provisioner = capture().provisioner, ...overrides }: Partial<DeployHandlerDeps> & { provisioner?: Provisioner } = {},
): DeployHandlerDeps => {
    return {
        backend,
        driverFor: () => fakeDriver(provisioner),
        releases: memoryReleaseStore().store,
        scheduler: scheduler(),
        ...overrides,
    };
};

const readLines = async (response: Response): Promise<Record<string, unknown>[]> => {
    const text = await response.text();

    return text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
};

const SPEC: TenantDeploymentSpec = {
    alias: "s",
    bundle: new ArrayBuffer(0),
    deploymentId: "dep_1",
    kind: "production",
    manifest: { bindings: [] },
    secrets: {},
    tags: [],
};

describe("orchestrator verify phase", () => {
    it("fails the deployment when the health check fails — never reports live", async () => {
        const phases: string[] = [];
        const outcome = await runDeployment(SPEC, {
            onProgress: (progress) => {
                phases.push(progress.phase);
            },
            driver: capture().provisioner,
            scheduler: scheduler(),
            verify: () => Promise.resolve(false),
        });

        expect(outcome.status).toBe("failed");
        expect(phases).toStrictEqual(["queued", "provisioning", "verifying", "failed"]);
    });

    it("goes live after a passing health check", async () => {
        const phases: string[] = [];
        const outcome = await runDeployment(SPEC, {
            onProgress: (progress) => {
                phases.push(progress.phase);
            },
            driver: capture().provisioner,
            scheduler: scheduler(),
            verify: () => Promise.resolve(true),
        });

        expect(outcome.status).toBe("live");
        expect(phases).toStrictEqual(["queued", "provisioning", "verifying", "live"]);
    });
});

describe("handler: one stable Worker per project", () => {
    it("updates the same script name on every deploy and stores each release", async () => {
        const { deployed, provisioner } = capture();
        const { objects, store } = memoryReleaseStore();
        let next = 0;
        const backend = backendWith({
            createDeployment: () => {
                next += 1;

                return Promise.resolve({ deploymentId: `dep_${String(next)}`, version: next });
            },
        });

        await readLines(
            await handleDeployRequest(request({ bundle: BUNDLE, projectId: "proj_1", scriptName: "app" }), deps(backend, { provisioner, releases: store })),
        );
        await readLines(
            await handleDeployRequest(request({ bundle: BUNDLE, projectId: "proj_1", scriptName: "app" }), deps(backend, { provisioner, releases: store })),
        );

        expect(deployed.map(({ spec }) => [spec.alias, spec.kind])).toStrictEqual([
            ["app", "production"],
            ["app", "production"],
        ]);
        expect([...objects.keys()]).toStrictEqual(["releases/dep_1.json", "releases/dep_2.json"]);
        await expect(store.get("dep_2")).resolves.toMatchObject({ bundle: BUNDLE });
    });

    it("activates a healthy release and emits released", async () => {
        const activate = vi.fn<NonNullable<DeployBackend["activateDeployment"]>>(() => Promise.resolve());

        const lines = await readLines(
            await handleDeployRequest(
                request({ bundle: BUNDLE, projectId: "proj_1", scriptName: "app" }),
                deps(backendWith({ activateDeployment: activate }), { healthCheck: () => Promise.resolve(true) }),
            ),
        );

        expect(activate).toHaveBeenCalledWith({ deploymentId: "dep_new", key: "k" });
        expect(lines.some((line) => line["event"] === "released")).toBe(true);
        expect(lines.at(-1)).toMatchObject({ done: true, status: "live" });
    });

    it("never provisions a release it could not store", async () => {
        const { deployed, provisioner } = capture();
        const releases = { ...memoryReleaseStore().store, put: () => Promise.reject(new Error("r2 down")) };

        const lines = await readLines(
            await handleDeployRequest(request({ bundle: BUNDLE, projectId: "proj_1", scriptName: "app" }), deps(backendWith({}), { provisioner, releases })),
        );

        expect(deployed).toHaveLength(0);
        expect(lines.at(-1)).toMatchObject({ done: true, status: "failed" });
    });

    it("re-provisions the previous live release when the health check fails after cutover", async () => {
        const { deployed, provisioner } = capture();
        const { store } = memoryReleaseStore();
        const activate = vi.fn<NonNullable<DeployBackend["activateDeployment"]>>(() => Promise.resolve());
        const statuses: string[] = [];

        await store.put("dep_prev", PREVIOUS);

        const lines = await readLines(
            await handleDeployRequest(
                request({ bundle: BUNDLE, projectId: "proj_1", scriptName: "app" }),
                deps(
                    backendWith({
                        activateDeployment: activate,
                        createDeployment: () => Promise.resolve({ deploymentId: "dep_new", previousDeploymentId: "dep_prev", version: 2 }),
                        updateStatus: ({ status }) => {
                            statuses.push(status);

                            return Promise.resolve();
                        },
                    }),
                    { healthCheck: () => Promise.resolve(false), provisioner, releases: store },
                ),
            ),
        );

        // The broken release went on the Worker, then the previous one went back on — same script.
        expect(deployed.map(({ bundle, spec }) => [spec.alias, bundle])).toStrictEqual([
            ["app", "export default { v: 2 }"],
            ["app", "export default { v: 1 }"],
        ]);
        // The revert carries the previous deployment's own admin token, not the failed one's.
        expect(deployed[1]?.spec.secrets["LUNORA_ADMIN_TOKEN"]).toBe("admin-prev");
        expect(lines).toContainEqual({ deploymentId: "dep_new", event: "reverted", to: "dep_prev" });
        expect(activate).not.toHaveBeenCalled();
        expect(statuses.at(-1)).toBe("failed");
        expect(lines.at(-1)).toMatchObject({ done: true, status: "failed" });
    });

    it("leaves the only release up when a first deploy fails its health check", async () => {
        const { deployed, provisioner } = capture();

        const lines = await readLines(
            await handleDeployRequest(
                request({ bundle: BUNDLE, projectId: "proj_1", scriptName: "app" }),
                deps(backendWith({}), { healthCheck: () => Promise.resolve(false), provisioner }),
            ),
        );

        expect(deployed).toHaveLength(1);
        expect(lines.some((line) => line["event"] === "not_reverted")).toBe(true);
        expect(lines.at(-1)).toMatchObject({ done: true, status: "failed" });
    });

    it("reports a revert that could not run, and still fails the release", async () => {
        const lines = await readLines(
            await handleDeployRequest(
                request({ bundle: BUNDLE, projectId: "proj_1", scriptName: "app" }),
                deps(backendWith({ createDeployment: () => Promise.resolve({ deploymentId: "dep_new", previousDeploymentId: "dep_pruned" }) }), {
                    healthCheck: () => Promise.resolve(false),
                }),
            ),
        );

        expect(lines).toContainEqual(expect.objectContaining({ event: "revert_failed", to: "dep_pruned" }));
        expect(lines.at(-1)).toMatchObject({ done: true, status: "failed" });
    });

    it("does not revert when provisioning itself failed — the Worker never left the previous release", async () => {
        const deploy = vi.fn<Provisioner["deploy"]>(() => Promise.reject(new Error("box failed")));

        const lines = await readLines(
            await handleDeployRequest(
                request({ bundle: BUNDLE, projectId: "proj_1", scriptName: "app" }),
                deps(backendWith({ createDeployment: () => Promise.resolve({ deploymentId: "dep_new", previousDeploymentId: "dep_prev" }) }), {
                    provisioner: { deploy, destroy: () => Promise.resolve() },
                }),
            ),
        );

        expect(deploy).toHaveBeenCalledTimes(1);
        expect(lines.some((line) => typeof line["event"] === "string" && line["event"].includes("revert"))).toBe(false);
    });

    it("downgrades the release to failed when activation throws", async () => {
        const lines = await readLines(
            await handleDeployRequest(
                request({ bundle: BUNDLE, projectId: "proj_1", scriptName: "app" }),
                deps(backendWith({ activateDeployment: () => Promise.reject(new Error("pointer swap failed")) })),
            ),
        );

        expect(lines.at(-1)).toMatchObject({ done: true, status: "failed" });
    });
});

describe(rollbackRelease, () => {
    const setup = async (target: Partial<ReleaseTarget> = {}) => {
        const { deployed, provisioner } = capture();
        const { store } = memoryReleaseStore();
        const rollbackDeployment = vi.fn<DeployBackend["rollbackDeployment"]>(() => Promise.resolve({ scriptName: "app", version: 1 }));

        await store.put("dep_prev", PREVIOUS);

        return {
            deployed,
            deps: deps(backendWith({ releaseTarget: () => Promise.resolve(releaseTarget(target)), rollbackDeployment }), { provisioner, releases: store }),
            rollbackDeployment,
            store,
        };
    };

    it("re-provisions the stored bundle onto the stable Worker, then records the rollback", async () => {
        const { deployed, deps: release, rollbackDeployment } = await setup();

        await expect(rollbackRelease({ deploymentId: "dep_prev", key: "k", organizationId: "org_1" }, release)).resolves.toStrictEqual({
            scriptName: "app",
            version: 1,
        });

        expect(deployed.map(({ bundle, spec }) => [spec.alias, bundle])).toStrictEqual([["app", "export default { v: 1 }"]]);
        expect(rollbackDeployment).toHaveBeenCalledWith({ deploymentId: "dep_prev", key: "k", organizationId: "org_1" });
    });

    it("refuses a release whose bundle was pruned, touching neither the Worker nor the record", async () => {
        const { deployed, deps: release, rollbackDeployment } = await setup();

        await expect(rollbackRelease({ deploymentId: "dep_gone", key: "k", organizationId: "org_1" }, release)).rejects.toMatchObject({ code: "CONFLICT" });

        expect(deployed).toHaveLength(0);
        expect(rollbackDeployment).not.toHaveBeenCalled();
    });

    it("refuses a rollback that would delete a Durable Object class the live release binds", async () => {
        const { deployed, deps: release, store } = await setup({ liveDeploymentId: "dep_live" });

        await store.put("dep_live", {
            bundle: BUNDLE,
            manifest: { bindings: [...PREVIOUS.manifest.bindings, { binding: "ROOMS", className: "Room", type: "durable_object" }] },
        });

        await expect(rollbackRelease({ deploymentId: "dep_prev", key: "k", organizationId: "org_1" }, release)).rejects.toThrow(/Room/u);
        expect(deployed).toHaveLength(0);
    });

    it("refuses to roll back onto a target the project no longer deploys to", async () => {
        const { deployed, deps: release, rollbackDeployment } = await setup({ target: "celld-vps" });

        await expect(rollbackRelease({ deploymentId: "dep_prev", key: "k", organizationId: "org_1" }, release)).rejects.toThrow(
            /deployed to celld-vps, but the project now deploys to cloudflare-wfp/u,
        );
        expect(deployed).toHaveLength(0);
        expect(rollbackDeployment).not.toHaveBeenCalled();
    });

    it("refuses a rollback the placement refuses (a project placed on another cell)", async () => {
        const { deployed, deps: release } = await setup();

        release.backend = { ...release.backend, placement: () => Promise.reject(new Error('placed on cell "eu-1"')) };

        await expect(rollbackRelease({ deploymentId: "dep_prev", key: "k", organizationId: "org_1" }, release)).rejects.toThrow(/eu-1/u);
        expect(deployed).toHaveLength(0);
    });

    it("does not record the rollback when the provision fails", async () => {
        const { deps: release, rollbackDeployment } = await setup();

        release.driverFor = () => fakeDriver({ deploy: () => Promise.reject(new Error("box failed")) });

        await expect(rollbackRelease({ deploymentId: "dep_prev", organizationId: "org_1" }, release)).rejects.toThrow("box failed");
        expect(rollbackDeployment).not.toHaveBeenCalled();
    });
});

describe("dispatcher routing", () => {
    it("serves the subdomain label as the script name — the alias is the script", async () => {
        await expect(resolveTenant("app.lunora.app", { appDomain: "lunora.app" })).resolves.toMatchObject({ scriptName: "app" });
        await expect(resolveTenant("app-pr-42.lunora.app", { appDomain: "lunora.app" })).resolves.toMatchObject({ scriptName: "app-pr-42" });
    });
});
