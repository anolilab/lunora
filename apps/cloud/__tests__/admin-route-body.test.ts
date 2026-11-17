import { describe, expect, it, vi } from "vitest";

import { handleAdminRoute } from "../src/deploy/routes/admin-proxy";

/**
 * `adminTarget` takes the admin path to decide the caller's role, and the
 * proxy forwards path and method to the tenant under its admin bearer. A value
 * of the wrong type must stop at the route as a 400, before either runs.
 */

type ActionPort = (reference: unknown, args?: Record<string, unknown>) => Promise<unknown>;

const makeCtx = () => {
    return {
        runAction: vi.fn<ActionPort>().mockResolvedValue({}),
        runMutation: vi.fn<ActionPort>().mockResolvedValue(null),
        runQuery: vi.fn<ActionPort>().mockResolvedValue(null),
    };
};

const post = (body: string): Request =>
    new Request("https://control.lunora.app/v1/admin", { body, headers: { "content-type": "application/json" }, method: "POST" });

const valid = { deploymentId: "dep_1", organizationId: "org_1", path: "tables" };

describe("handleAdminRoute body validation", () => {
    it.each([
        ["invalid JSON", "{"],
        ["a JSON array", JSON.stringify([valid])],
        ["a JSON string", JSON.stringify("tables")],
        ["a non-string path", JSON.stringify({ ...valid, path: { toString: "tables" } })],
        ["an array path", JSON.stringify({ ...valid, path: ["tables"] })],
        ["a numeric organizationId", JSON.stringify({ ...valid, organizationId: 7 })],
        ["an object deploymentId", JSON.stringify({ ...valid, deploymentId: { id: "dep_1" } })],
        ["a non-string method", JSON.stringify({ ...valid, method: ["GET"] })],
    ])("answers 400 for %s without resolving a target", async (_label, body) => {
        const ctx = makeCtx();
        const response = await handleAdminRoute(post(body), { __lunoraCtx: ctx });

        expect(response.status).toBe(400);
        expect(ctx.runQuery).not.toHaveBeenCalled();
        expect(ctx.runMutation).not.toHaveBeenCalled();
    });

    it("resolves the target for a well-formed body", async () => {
        const ctx = makeCtx();
        const response = await handleAdminRoute(post(JSON.stringify(valid)), { __lunoraCtx: ctx });

        expect(response.status).toBe(404);
        expect(ctx.runQuery).toHaveBeenCalledWith(expect.anything(), { adminPath: "tables", deploymentId: "dep_1", organizationId: "org_1" });
    });
});
