import { describe, expect, it, vi } from "vitest";

import type { DeployBackend, DeployHandlerDeps } from "../src/deploy/handler";
import { handleDeployRequest } from "../src/deploy/handler";
import { runDeployment } from "../src/deploy/orchestrator";
import { CellScheduler } from "../src/deploy/scheduler";
import { TokenBucket } from "../src/deploy/token-bucket";
import { createRouteResolver, resolveTenant } from "../src/dispatcher/route";
import type { Provisioner } from "../src/provision";

/**
 * Blue/green release flow (GAPS.md A1): versioned scripts, health-gated
 * activation, rollback-ready pointer semantics, and the dispatcher's
 * alias → active-script resolution.
 */

const BUNDLE = btoa("export default {}");

const scheduler = (): CellScheduler => new CellScheduler({ bucket: new TokenBucket({ capacity: 100, refillPerWindow: 100, windowMs: 1000 }) });

const okProvisioner: Provisioner = {
    deploy: () => Promise.resolve({ bundleHash: "h1", scriptName: "app-v2", url: "https://app-v2.lunora.app" }),
    destroy: () => Promise.resolve(),
};

const request = (body: unknown): Request =>
    new Request("https://cloud/v1/deploy", {
        body: JSON.stringify(body),
        headers: { authorization: "Bearer k", "content-type": "application/json" },
        method: "POST",
    });

const backendWith = (overrides: Partial<DeployBackend>): DeployBackend => {
    return {
        createDeployment: () => Promise.resolve({ deploymentId: "dep_1", scriptName: "app-v2", version: 2 }),
        updateStatus: () => Promise.resolve(),
        verifyKey: () => Promise.resolve({ organizationId: "org_1", projectId: "proj_1", type: "production" as const }),
        ...overrides,
    };
};

const deps = (backend: DeployBackend, overrides: Partial<DeployHandlerDeps> = {}): DeployHandlerDeps => {
    return {
        backend,
        cell: "cell-1",
        dispatchNamespace: (kind) => `lunora-${kind}`,
        provisioner: okProvisioner,
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

describe("orchestrator verify phase", () => {
    it("fails the deployment when the health check fails — never reports live", async () => {
        const phases: string[] = [];
        const outcome = await runDeployment(
            { bindings: {}, bundle: new ArrayBuffer(0), cell: "c", dispatchNamespace: "ns", scriptName: "s", secrets: {}, tags: [] },
            {
                onProgress: (progress) => {
                    phases.push(progress.phase);
                },
                provisioner: okProvisioner,
                scheduler: scheduler(),
                verify: () => Promise.resolve(false),
            },
        );

        expect(outcome.status).toBe("failed");
        expect(phases).toStrictEqual(["queued", "provisioning", "verifying", "failed"]);
        expect(phases).not.toContain("live");
    });

    it("goes live after a passing health check", async () => {
        const phases: string[] = [];
        const outcome = await runDeployment(
            { bindings: {}, bundle: new ArrayBuffer(0), cell: "c", dispatchNamespace: "ns", scriptName: "s", secrets: {}, tags: [] },
            {
                onProgress: (progress) => {
                    phases.push(progress.phase);
                },
                provisioner: okProvisioner,
                scheduler: scheduler(),
                verify: () => Promise.resolve(true),
            },
        );

        expect(outcome.status).toBe("live");
        expect(phases).toStrictEqual(["queued", "provisioning", "verifying", "live"]);
    });
});

describe("handler release flow", () => {
    it("uploads the versioned script from createDeployment, activates it, and emits released", async () => {
        let uploadedScript = "";
        const activate = vi.fn(() => Promise.resolve());
        const capturing: Provisioner = {
            deploy: (spec) => {
                uploadedScript = spec.scriptName;

                return Promise.resolve({ bundleHash: "h1", scriptName: spec.scriptName, url: `https://${spec.scriptName}.lunora.app` });
            },
            destroy: () => Promise.resolve(),
        };

        const response = await handleDeployRequest(
            request({ bundle: BUNDLE, projectId: "proj_1", scriptName: "app" }),
            deps(backendWith({ activateDeployment: activate }), { healthCheck: () => Promise.resolve(true), provisioner: capturing }),
        );
        const lines = await readLines(response);

        expect(uploadedScript).toBe("app-v2");
        expect(activate).toHaveBeenCalledWith({ deploymentId: "dep_1", key: "k" });
        expect(lines.some((line) => line["event"] === "released")).toBe(true);
        expect(lines.at(-1)).toMatchObject({ done: true, status: "live" });
    });

    it("fails the release without activating when the health check fails", async () => {
        const activate = vi.fn(() => Promise.resolve());
        const statuses: string[] = [];

        const response = await handleDeployRequest(
            request({ bundle: BUNDLE, projectId: "proj_1", scriptName: "app" }),
            deps(
                backendWith({
                    activateDeployment: activate,
                    updateStatus: ({ status }) => {
                        statuses.push(status);

                        return Promise.resolve();
                    },
                }),
                { healthCheck: () => Promise.resolve(false) },
            ),
        );
        const lines = await readLines(response);

        expect(activate).not.toHaveBeenCalled();
        expect(lines.at(-1)).toMatchObject({ done: true, status: "failed" });
        expect(statuses).toContain("verifying");
        expect(statuses).toContain("failed");
    });

    it("downgrades the release to failed when activation throws", async () => {
        const response = await handleDeployRequest(
            request({ bundle: BUNDLE, projectId: "proj_1", scriptName: "app" }),
            deps(backendWith({ activateDeployment: () => Promise.reject(new Error("pointer swap failed")) })),
        );
        const lines = await readLines(response);

        expect(lines.at(-1)).toMatchObject({ done: true, status: "failed" });
    });
});

describe("dispatcher alias routing", () => {
    it("resolves a stable alias to the active versioned script", async () => {
        const route = await resolveTenant("app.lunora.app", {
            appDomain: "lunora.app",
            resolveAlias: (label) => Promise.resolve(label === "app" ? "app-v7" : null),
        });

        expect(route?.scriptName).toBe("app-v7");
    });

    it("falls back to the literal label when the alias is unknown (previews)", async () => {
        const route = await resolveTenant("app-pr-42.lunora.app", {
            appDomain: "lunora.app",
            resolveAlias: () => Promise.resolve(null),
        });

        expect(route?.scriptName).toBe("app-pr-42");
    });

    it("createRouteResolver caches lookups and fails open to null", async () => {
        const fetchMock = vi.fn(() => Promise.resolve(Response.json({ scriptName: "app-v3" })));
        const resolve = createRouteResolver({
            controlPlaneToken: "t",
            controlPlaneUrl: "https://cp",
            fetch: fetchMock,
            now: () => 0,
        });

        await expect(resolve("app")).resolves.toBe("app-v3");
        await expect(resolve("app")).resolves.toBe("app-v3");
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const failing = createRouteResolver({
            controlPlaneToken: "t",
            controlPlaneUrl: "https://cp",
            fetch: () => Promise.reject(new Error("down")),
        });

        await expect(failing("app")).resolves.toBeNull();
    });
});
