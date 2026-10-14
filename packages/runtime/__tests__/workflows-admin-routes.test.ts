import type { WorkflowsRestClient } from "@lunora/workflow";
import { describe, expect, it } from "vitest";

import { buildWorkflowsAdminRoutes, WORKFLOWS_INSTANCE_PATH, WORKFLOWS_INSTANCES_PATH, WORKFLOWS_STATUS_PATH } from "../src/workflows-admin-routes";

/** A fake REST client (typed against the real interface) that records its calls and returns canned payloads. */
const fakeClient = (): { calls: { args: unknown; method: string }[]; client: WorkflowsRestClient } => {
    const calls: { args: unknown; method: string }[] = [];

    const client: WorkflowsRestClient = {
        getInstance: async (args) => {
            calls.push({ args, method: "getInstance" });

            return { id: "i1", status: "complete", steps: [] };
        },
        listInstances: async (args) => {
            calls.push({ args, method: "listInstances" });

            return { instances: [], page: 1, perPage: 25 };
        },
        setInstanceStatus: async (args) => {
            calls.push({ args, method: "setInstanceStatus" });

            return { status: "paused" };
        },
    };

    return { calls, client };
};

const allow = (): void => undefined;
const get = (path: string, query = ""): Request => new Request(`https://app.test${path}${query}`, { method: "GET" });
const post = (path: string, body: unknown): Request =>
    new Request(`https://app.test${path}`, { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST" });

describe("workflows admin routes", () => {
    it("lists instances, forwarding name/status/paging to the client", async () => {
        expect.assertions(2);

        const { calls, client } = fakeClient();
        const routes = buildWorkflowsAdminRoutes({ assertAdmin: allow, resolveWorkflowsClient: () => client });

        const response = await routes[WORKFLOWS_INSTANCES_PATH]?.(
            get(WORKFLOWS_INSTANCES_PATH, "?name=orders&status=running&page=2&perPage=10"),
            {},
            new URL(`https://app.test${WORKFLOWS_INSTANCES_PATH}?name=orders&status=running&page=2&perPage=10`),
        );

        expect(response?.status).toBe(200);
        expect(calls[0]).toStrictEqual({ args: { page: 2, perPage: 10, status: "running", workflowName: "orders" }, method: "listInstances" });
    });

    it("reads one instance by name + id", async () => {
        expect.assertions(1);

        const { calls, client } = fakeClient();
        const routes = buildWorkflowsAdminRoutes({ assertAdmin: allow, resolveWorkflowsClient: () => client });

        await routes[WORKFLOWS_INSTANCE_PATH]?.(
            get(WORKFLOWS_INSTANCE_PATH, "?name=orders&id=i1"),
            {},
            new URL(`https://app.test${WORKFLOWS_INSTANCE_PATH}?name=orders&id=i1`),
        );

        expect(calls[0]).toStrictEqual({ args: { instanceId: "i1", workflowName: "orders" }, method: "getInstance" });
    });

    it("patches status for a valid lifecycle action", async () => {
        expect.assertions(2);

        const { calls, client } = fakeClient();
        const routes = buildWorkflowsAdminRoutes({ assertAdmin: allow, resolveWorkflowsClient: () => client });

        const response = await routes[WORKFLOWS_STATUS_PATH]?.(
            post(WORKFLOWS_STATUS_PATH, { action: "pause", id: "i1", name: "orders" }),
            {},
            new URL(`https://app.test${WORKFLOWS_STATUS_PATH}`),
        );

        expect(response?.status).toBe(200);
        expect(calls[0]).toStrictEqual({ args: { action: "pause", instanceId: "i1", workflowName: "orders" }, method: "setInstanceStatus" });
    });

    it("returns a 200 `configured: false` sentinel from the instances list when no client is resolvable", async () => {
        expect.assertions(2);

        // The list is the one workflows endpoint the studio fetches on mount, so an
        // unconfigured worker answers with a 200 empty page (not a 501) — the studio
        // renders its "set credentials" state without the browser logging a failed
        // request. Mirrors the OpenAPI/OpenRPC introspection routes.
        const routes = buildWorkflowsAdminRoutes({ assertAdmin: allow, resolveWorkflowsClient: () => undefined });

        const response = await routes[WORKFLOWS_INSTANCES_PATH]?.(
            get(WORKFLOWS_INSTANCES_PATH, "?name=orders"),
            {},
            new URL(`https://app.test${WORKFLOWS_INSTANCES_PATH}?name=orders`),
        );

        expect(response?.status).toBe(200);
        await expect(response?.json()).resolves.toStrictEqual({ configured: false, instances: [], page: 1, perPage: 0, totalCount: 0 });
    });

    it("rejects the instance-detail endpoint with 501 WORKFLOWS_NOT_CONFIGURED when no client is resolvable", async () => {
        expect.assertions(1);

        // Detail/status keep throwing — they're only reachable once instances exist,
        // so they never fire (or log) while inspection is unconfigured.
        const routes = buildWorkflowsAdminRoutes({ assertAdmin: allow, resolveWorkflowsClient: () => undefined });

        await expect(
            routes[WORKFLOWS_INSTANCE_PATH]?.(
                get(WORKFLOWS_INSTANCE_PATH, "?name=orders&id=i1"),
                {},
                new URL(`https://app.test${WORKFLOWS_INSTANCE_PATH}?name=orders&id=i1`),
            ),
        ).rejects.toMatchObject({ code: "WORKFLOWS_NOT_CONFIGURED", status: 501 });
    });

    it("rejects a missing `name` with 400", async () => {
        expect.assertions(1);

        const { client } = fakeClient();
        const routes = buildWorkflowsAdminRoutes({ assertAdmin: allow, resolveWorkflowsClient: () => client });

        await expect(
            routes[WORKFLOWS_INSTANCES_PATH]?.(get(WORKFLOWS_INSTANCES_PATH), {}, new URL(`https://app.test${WORKFLOWS_INSTANCES_PATH}`)),
        ).rejects.toMatchObject({ status: 400 });
    });

    it("rejects an unknown status action with 400", async () => {
        expect.assertions(1);

        const { client } = fakeClient();
        const routes = buildWorkflowsAdminRoutes({ assertAdmin: allow, resolveWorkflowsClient: () => client });

        await expect(
            routes[WORKFLOWS_STATUS_PATH]?.(
                post(WORKFLOWS_STATUS_PATH, { action: "explode", id: "i1", name: "orders" }),
                {},
                new URL(`https://app.test${WORKFLOWS_STATUS_PATH}`),
            ),
        ).rejects.toMatchObject({ status: 400 });
    });

    it("enforces the admin gate (a throwing assertAdmin blocks the call)", async () => {
        expect.assertions(1);

        const deny = (): void => {
            throw new Error("forbidden");
        };
        const { client } = fakeClient();
        const routes = buildWorkflowsAdminRoutes({ assertAdmin: deny, resolveWorkflowsClient: () => client });

        await expect(
            routes[WORKFLOWS_INSTANCES_PATH]?.(
                get(WORKFLOWS_INSTANCES_PATH, "?name=orders"),
                {},
                new URL(`https://app.test${WORKFLOWS_INSTANCES_PATH}?name=orders`),
            ),
        ).rejects.toThrow("forbidden");
    });
});
