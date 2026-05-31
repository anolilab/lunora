import { describe, expect, test, vi } from "vitest";

import type { AuthIntrospector, ExecutionContextLike } from "../src/create-worker.js";
import { createWorker } from "../src/create-worker.js";
import type { ShardNamespaceLike } from "../src/resolve-shard.js";

const fakeCtx: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const noopNamespace: ShardNamespaceLike = {
    get: () => ({ fetch: async () => new Response("not used", { status: 200 }) }),
    idFromName: (name) => ({ __name: name }),
};

const ADMIN_TOKEN = "admin-bear";

const USERS = { rows: [{ email: "a@example.com", id: "u1" }], total: 1 };
const SESSIONS = { rows: [{ id: "s1", userId: "u1" }], total: 1 };

const introspector = (): AuthIntrospector => ({
    listSessions: vi.fn(async () => SESSIONS),
    listUsers: vi.fn(async () => USERS),
});

const authed = (url: string): Request => new Request(url, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" });

describe("createWorker — auth introspection endpoints", () => {
    test("users rejects without a valid admin bearer (403)", async () => {
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authIntrospector: introspector(), shardDO: noopNamespace });

        const response = await worker.fetch(new Request("https://app.example/_cirrus/admin/auth/users", { method: "GET" }), {}, fakeCtx);

        expect(response.status).toBe(403);
    });

    test("users reports AUTH_NOT_CONFIGURED when no introspector is bound (400)", async () => {
        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace });

        const response = await worker.fetch(authed("https://app.example/_cirrus/admin/auth/users"), {}, fakeCtx);

        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe("AUTH_NOT_CONFIGURED");
    });

    test("users returns the introspector's page and forwards paging", async () => {
        const intro = introspector();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authIntrospector: intro, shardDO: noopNamespace });

        const response = await worker.fetch(authed("https://app.example/_cirrus/admin/auth/users?limit=10&offset=5"), {}, fakeCtx);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual(USERS);
        expect(intro.listUsers).toHaveBeenCalledWith({ limit: 10, offset: 5 });
    });

    test("sessions forwards userId + paging and returns the page", async () => {
        const intro = introspector();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authIntrospector: intro, shardDO: noopNamespace });

        const response = await worker.fetch(authed("https://app.example/_cirrus/admin/auth/sessions?userId=u1&limit=20"), {}, fakeCtx);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual(SESSIONS);
        expect(intro.listSessions).toHaveBeenCalledWith({ limit: 20, offset: undefined, userId: "u1" });
    });

    test("sessions without a userId passes undefined", async () => {
        const intro = introspector();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authIntrospector: intro, shardDO: noopNamespace });

        await worker.fetch(authed("https://app.example/_cirrus/admin/auth/sessions"), {}, fakeCtx);

        expect(intro.listSessions).toHaveBeenCalledWith({ limit: undefined, offset: undefined, userId: undefined });
    });

    test("users rejects non-GET (405)", async () => {
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authIntrospector: introspector(), shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/auth/users", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "POST" }),
            {},
            fakeCtx,
        );

        expect(response.status).toBe(405);
    });
});
