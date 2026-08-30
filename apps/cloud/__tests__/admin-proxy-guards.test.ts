import { describe, expect, it, vi } from "vitest";

import { proxyAdminRequest } from "../src/admin/proxy";

/**
 * The studio's admin proxy forwards a caller-chosen path and verb to a tenant
 * Worker **carrying that tenant's own admin bearer**.
 *
 * That makes an unvalidated path a confused deputy rather than a routing detail:
 * `..` segments normalise away inside the URL parser, so `../../x` escaped the
 * `/_lunora/admin/` prefix and reached any route on the tenant, authenticated as
 * the platform. A caller-chosen method then decided whether that was a read or a
 * write.
 */

type FetchSpy = typeof globalThis.fetch;

const deps = (fetchImpl: ReturnType<typeof vi.fn>) => {
    return {
        authorize: vi.fn<() => Promise<void>>(() => Promise.resolve()),
        fetch: fetchImpl as unknown as typeof globalThis.fetch,
        recordAudit: vi.fn<() => Promise<void>>(() => Promise.resolve()),
        resolveTarget: () => Promise.resolve({ adminToken: "tenant-admin-token", url: "https://tenant.example" }),
    };
};

const request = (over: Record<string, unknown> = {}) => {
    return { deploymentId: "dep_1", method: "GET", organizationId: "org_1", path: "tables", ...over };
};

describe("proxyAdminRequest path guard", () => {
    it.each([
        ["../../secrets", "parent traversal"],
        ["..%2f..%2fsecrets", "encoded traversal"],
        ["tables?x=1", "a query string"],
        ["https://evil.example/x", "an absolute URL"],
        ["", "an empty path"],
    ])("refuses %s (%s) without contacting the tenant", async (path) => {
        const fetchImpl = vi.fn<FetchSpy>();
        const response = await proxyAdminRequest(request({ path }), deps(fetchImpl));

        expect(response.status).toBe(400);
        // The tenant's admin bearer must never leave the control plane for a
        // request we already know is malformed.
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("forwards an ordinary nested admin path", async () => {
        const fetchImpl = vi.fn<FetchSpy>(() => Promise.resolve(new Response("{}", { status: 200 })));
        const response = await proxyAdminRequest(request({ path: "tables/rows" }), deps(fetchImpl));

        expect(response.status).toBe(200);
        expect(fetchImpl).toHaveBeenCalledWith("https://tenant.example/_lunora/admin/tables/rows", expect.anything());
    });
});

describe("proxyAdminRequest method guard", () => {
    it("refuses a verb the studio never uses", async () => {
        const fetchImpl = vi.fn<FetchSpy>();
        const response = await proxyAdminRequest(request({ method: "DELETE" }), deps(fetchImpl));

        expect(response.status).toBe(405);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("allows the two the studio does", async () => {
        for (const method of ["GET", "POST"]) {
            const fetchImpl = vi.fn<FetchSpy>(() => Promise.resolve(new Response("{}", { status: 200 })));
            // eslint-disable-next-line no-await-in-loop -- two cases, sequential keeps the assertion readable
            const response = await proxyAdminRequest(request({ method }), deps(fetchImpl));

            expect(response.status).toBe(200);
        }
    });
});
