import { describe, expect, it } from "vitest";

import type { DeployBackend, DeployHandlerDeps, DeployTarget } from "../src/deploy/handler";
import { handleDeployRequest } from "../src/deploy/handler";
import { CellScheduler } from "../src/deploy/scheduler";
import { TokenBucket } from "../src/deploy/token-bucket";
import type { Provisioner } from "../src/provision";

const target: DeployTarget = { organizationId: "org_1", projectId: "proj_1", type: "production" };

const okProvisioner: Provisioner = {
    deploy: () => Promise.resolve({ bundleHash: "h1", scriptName: "s", url: "https://proj.cirrus.app" }),
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
        dispatchNamespace: (kind) => `cirrus-${kind}`,
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
        const response = await handleDeployRequest(request(null, { projectId: "proj_1", scriptName: "s" }), deps(backendWith({}), okProvisioner));

        expect(response.status).toBe(401);
    });

    it("403 for an invalid/revoked key", async () => {
        const response = await handleDeployRequest(
            request("bad", { projectId: "proj_1", scriptName: "s" }),
            deps(backendWith({ verifyKey: () => Promise.resolve(null) }), okProvisioner),
        );

        expect(response.status).toBe(403);
    });

    it("400 when projectId/scriptName are missing", async () => {
        const response = await handleDeployRequest(request("k", {}), deps(backendWith({}), okProvisioner));

        expect(response.status).toBe(400);
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

        const response = await handleDeployRequest(request("k", { projectId: "proj_1", scriptName: "s" }), deps(backend, okProvisioner));

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

        const response = await handleDeployRequest(request("k", { projectId: "proj_1", scriptName: "s" }), deps(backend, failing));
        const lines = await readLines(response);

        expect(lines.at(-1)).toMatchObject({ done: true, status: "failed" });
        expect(statuses).toStrictEqual(["provisioning", "failed"]);
    });
});
