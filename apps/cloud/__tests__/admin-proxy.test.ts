import { describe, expect, it, vi } from "vitest";

import type { AdminProxyDeps } from "../src/admin/proxy";
import { proxyAdminRequest } from "../src/admin/proxy";

const baseDeps = (overrides: Partial<AdminProxyDeps>): AdminProxyDeps => {
    return {
        authorize: () => Promise.resolve(),
        recordAudit: () => Promise.resolve(),
        resolveTarget: () => Promise.resolve({ adminToken: "tok", url: "https://tenant.example.com" }),
        ...overrides,
    };
};

describe(proxyAdminRequest, () => {
    it("forwards to the tenant admin endpoint with the bearer token and records audit", async () => {
        const fetchMock = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(async () => new Response("[]", { status: 200 }));
        const audits: { action: string; organizationId: string }[] = [];
        const deps = baseDeps({
            fetch: fetchMock as unknown as typeof fetch,
            recordAudit: (entry) => {
                audits.push(entry);

                return Promise.resolve();
            },
        });

        const response = await proxyAdminRequest({ deploymentId: "dep_1", method: "GET", organizationId: "org_1", path: "functions" }, deps);

        const [url, init] = fetchMock.mock.calls[0];

        expect(url).toBe("https://tenant.example.com/_lunora/admin/functions");
        expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer tok");
        expect(response.status).toBe(200);
        expect(audits).toStrictEqual([{ action: "admin.functions", organizationId: "org_1" }]);
    });

    it("404s when the deployment can't be resolved", async () => {
        const response = await proxyAdminRequest(
            { deploymentId: "missing", method: "GET", organizationId: "org_1", path: "functions" },
            baseDeps({ resolveTarget: () => Promise.resolve(null) }),
        );

        expect(response.status).toBe(404);
    });

    it("propagates an authorization failure", async () => {
        const deps = baseDeps({ authorize: () => Promise.reject(new Error("not a member")) });

        await expect(proxyAdminRequest({ deploymentId: "dep_1", method: "GET", organizationId: "org_1", path: "x" }, deps)).rejects.toThrow("not a member");
    });
});
