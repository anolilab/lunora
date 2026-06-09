import { describe, expect, it, vi } from "vitest";

import type { AuthIntrospector, ExecutionContextLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const noopNamespace: ShardNamespaceLike = {
    get: () => {
        return { fetch: async () => new Response("not used", { status: 200 }) };
    },
    idFromName: (name) => {
        return { __name: name };
    },
};

const ADMIN_TOKEN = "admin-bear";

const USERS = { rows: [{ email: "a@example.com", id: "u1" }], total: 1 };
const SESSIONS = { rows: [{ id: "s1", userId: "u1" }], total: 1 };

const introspector = (): AuthIntrospector => {
    return {
        listSessions: vi.fn<AuthIntrospector["listSessions"]>(async () => SESSIONS),
        listUsers: vi.fn<AuthIntrospector["listUsers"]>(async () => USERS),
    };
};

const authed = (url: string): Request => new Request(url, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" });

describe("createWorker — auth introspection endpoints", () => {
    it("users rejects without a valid admin bearer (403)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, authIntrospector: introspector(), shardDO: noopNamespace });

        const response = await worker.fetch(new Request("https://app.example/_cirrus/admin/auth/users", { method: "GET" }), {}, fakeContext);

        expect(response.status).toBe(403);
    });

    it("users reports AUTH_NOT_CONFIGURED when no introspector is bound (400)", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace });

        const response = await worker.fetch(authed("https://app.example/_cirrus/admin/auth/users"), {}, fakeContext);

        expect(response.status).toBe(400);

        const body: { error: { code: string } } = await response.json();

        expect(body.error.code).toBe("AUTH_NOT_CONFIGURED");
    });

    it("users returns the introspector's page and forwards paging", async () => {
        expect.assertions(3);

        const intro = introspector();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authIntrospector: intro, shardDO: noopNamespace });

        const response = await worker.fetch(authed("https://app.example/_cirrus/admin/auth/users?limit=10&offset=5"), {}, fakeContext);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual(USERS);
        expect(intro.listUsers).toHaveBeenCalledWith({ limit: 10, offset: 5 });
    });

    it("sessions forwards userId + paging and returns the page", async () => {
        expect.assertions(3);

        const intro = introspector();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authIntrospector: intro, shardDO: noopNamespace });

        const response = await worker.fetch(authed("https://app.example/_cirrus/admin/auth/sessions?userId=u1&limit=20"), {}, fakeContext);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual(SESSIONS);
        expect(intro.listSessions).toHaveBeenCalledWith({ limit: 20, offset: undefined, userId: "u1" });
    });

    it("sessions without a userId passes undefined", async () => {
        expect.assertions(1);

        const intro = introspector();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authIntrospector: intro, shardDO: noopNamespace });

        await worker.fetch(authed("https://app.example/_cirrus/admin/auth/sessions"), {}, fakeContext);

        expect(intro.listSessions).toHaveBeenCalledWith({ limit: undefined, offset: undefined, userId: undefined });
    });

    it("users rejects non-GET (405)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, authIntrospector: introspector(), shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/auth/users", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "POST" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(405);
    });
});
