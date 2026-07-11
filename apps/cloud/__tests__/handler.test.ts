import { describe, expect, it } from "vitest";

import type { DeployBackend, DeployHandlerDeps, DeployTarget } from "../src/deploy/handler";
import { handleDeployRequest } from "../src/deploy/handler";
import { CellScheduler } from "../src/deploy/scheduler";
import { TokenBucket } from "../src/deploy/token-bucket";
import type { Provisioner } from "../src/provision";

const target: DeployTarget = { organizationId: "org_1", projectId: "proj_1", type: "production" };

// base64("export default {}") — the prebuilt worker module the client uploads.
const BUNDLE = btoa("export default {}");

const okProvisioner: Provisioner = {
    deploy: () => Promise.resolve({ bundleHash: "h1", scriptName: "s", url: "https://proj.lunora.app" }),
    destroy: () => Promise.resolve(),
};

const request = (key: null | string, body: unknown): Request =>
    new Request("https://cloud/v1/deploy", {
        body: JSON.stringify(body),
        headers: key ? { authorization: `Bearer ${key}`, "content-type": "application/json" } : { "content-type": "application/json" },
        method: "POST",
    });

const deps = (backend: DeployBackend, provisioner: Provisioner): DeployHandlerDeps => {
    return {
        backend,
        cell: "cell-1",
        dispatchNamespace: (kind) => `lunora-${kind}`,
        provisioner,
        scheduler: new CellScheduler({ bucket: new TokenBucket({ capacity: 100, refillPerWindow: 100, windowMs: 1000 }) }),
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

const backendWith = (overrides: Partial<DeployBackend>): DeployBackend => {
    return {
        createDeployment: () => Promise.resolve({ deploymentId: "dep_1" }),
        updateStatus: () => Promise.resolve(),
        verifyKey: () => Promise.resolve(target),
        ...overrides,
    };
};

describe(handleDeployRequest, () => {
    it("401 without a bearer deploy key", async () => {
        const response = await handleDeployRequest(
            request(null, { bundle: BUNDLE, projectId: "proj_1", scriptName: "s" }),
            deps(backendWith({}), okProvisioner),
        );

        expect(response.status).toBe(401);
    });

    it("403 for an invalid/revoked key", async () => {
        const response = await handleDeployRequest(
            request("bad", { bundle: BUNDLE, projectId: "proj_1", scriptName: "s" }),
            deps(backendWith({ verifyKey: () => Promise.resolve(null) }), okProvisioner),
        );

        expect(response.status).toBe(403);
    });

    it("400 when projectId/scriptName are missing", async () => {
        const response = await handleDeployRequest(request("k", {}), deps(backendWith({}), okProvisioner));

        expect(response.status).toBe(400);
    });

    it("400 when the bundle is missing — never provisions an empty module", async () => {
        const response = await handleDeployRequest(request("k", { projectId: "proj_1", scriptName: "s" }), deps(backendWith({}), okProvisioner));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("bundle") as string });
    });

    it("400 when the bundle is not valid base64", async () => {
        const response = await handleDeployRequest(
            request("k", { bundle: "!!not-base64!!", projectId: "proj_1", scriptName: "s" }),
            deps(backendWith({}), okProvisioner),
        );

        expect(response.status).toBe(400);
    });

    it("passes the decoded bundle bytes to the provisioner", async () => {
        let uploaded: ArrayBuffer | undefined;
        const capturing: Provisioner = {
            deploy: (spec) => {
                uploaded = spec.bundle;

                return Promise.resolve({ bundleHash: "h1", scriptName: spec.scriptName, url: "https://proj.lunora.app" });
            },
            destroy: () => Promise.resolve(),
        };

        const response = await handleDeployRequest(request("k", { bundle: BUNDLE, projectId: "proj_1", scriptName: "s" }), deps(backendWith({}), capturing));

        await response.text();

        expect(uploaded).toBeDefined();
        expect(new TextDecoder().decode(uploaded)).toBe("export default {}");
    });

    it("streams accepted → queued → provisioning → live and records status transitions", async () => {
        const statuses: string[] = [];
        const backend = backendWith({
            createDeployment: () => Promise.resolve({ deploymentId: "dep_42" }),
            updateStatus: ({ status }) => {
                statuses.push(status);

                return Promise.resolve();
            },
        });

        const response = await handleDeployRequest(request("k", { bundle: BUNDLE, projectId: "proj_1", scriptName: "s" }), deps(backend, okProvisioner));

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("application/x-ndjson");

        const lines = await readLines(response);

        expect(lines[0]).toMatchObject({ deploymentId: "dep_42", event: "accepted" });
        expect(lines.map((line) => line["phase"]).filter(Boolean)).toStrictEqual(["queued", "provisioning", "live"]);
        expect(lines.at(-1)).toMatchObject({ done: true, status: "live" });
        // queued is the create state — status is only patched for provisioning/live/failed.
        expect(statuses).toStrictEqual(["provisioning", "live"]);
    });

    it("streams a failed terminal event when provisioning rejects", async () => {
        const statuses: string[] = [];
        const backend = backendWith({
            updateStatus: ({ status }) => {
                statuses.push(status);

                return Promise.resolve();
            },
        });
        const failing: Provisioner = { deploy: () => Promise.reject(new Error("alchemy not wired")), destroy: () => Promise.resolve() };

        const response = await handleDeployRequest(request("k", { bundle: BUNDLE, projectId: "proj_1", scriptName: "s" }), deps(backend, failing));
        const lines = await readLines(response);

        expect(lines.at(-1)).toMatchObject({ done: true, status: "failed" });
        expect(statuses).toStrictEqual(["provisioning", "failed"]);
    });
});
