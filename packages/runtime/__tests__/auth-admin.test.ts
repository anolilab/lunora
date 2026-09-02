import { LunoraError } from "@lunora/errors";
import { describe, expect, it, vi } from "vitest";

import type { AuthAdmin, ExecutionContextLike } from "../src/create-worker";
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

/** A minimal read-only auth plane — just the required browse ops, no mutations. */
const readOnlyAuthAdmin = (): Pick<AuthAdmin, "listSessions" | "listUsers"> => {
    return {
        listSessions: vi.fn<AuthAdmin["listSessions"]>(async () => SESSIONS),
        listUsers: vi.fn<AuthAdmin["listUsers"]>(async () => USERS),
    };
};

const authed = (url: string): Request => new Request(url, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" });

describe("createWorker — auth introspection endpoints", () => {
    it("users rejects without a valid admin bearer (403)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: readOnlyAuthAdmin(), shardDO: noopNamespace });

        const response = await worker.fetch(new Request("https://app.example/_lunora/admin/auth/users", { method: "GET" }), {}, fakeContext);

        expect(response.status).toBe(403);
    });

    it("users reports AUTH_NOT_CONFIGURED when no auth plane is bound (400)", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace });

        const response = await worker.fetch(authed("https://app.example/_lunora/admin/auth/users"), {}, fakeContext);

        expect(response.status).toBe(400);

        const body: { error: { code: string } } = await response.json();

        expect(body.error.code).toBe("AUTH_NOT_CONFIGURED");
    });

    it("users returns the auth plane's page and forwards paging", async () => {
        expect.assertions(3);

        const intro = readOnlyAuthAdmin();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: intro, shardDO: noopNamespace });

        const response = await worker.fetch(authed("https://app.example/_lunora/admin/auth/users?limit=10&offset=5"), {}, fakeContext);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual(USERS);
        expect(intro.listUsers).toHaveBeenCalledWith({ limit: 10, offset: 5 });
    });

    it("sessions forwards userId + paging and returns the page", async () => {
        expect.assertions(3);

        const intro = readOnlyAuthAdmin();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: intro, shardDO: noopNamespace });

        const response = await worker.fetch(authed("https://app.example/_lunora/admin/auth/sessions?userId=u1&limit=20"), {}, fakeContext);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual(SESSIONS);
        expect(intro.listSessions).toHaveBeenCalledWith({ limit: 20, offset: undefined, userId: "u1" });
    });

    it("sessions without a userId passes undefined", async () => {
        expect.assertions(1);

        const intro = readOnlyAuthAdmin();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: intro, shardDO: noopNamespace });

        await worker.fetch(authed("https://app.example/_lunora/admin/auth/sessions"), {}, fakeContext);

        expect(intro.listSessions).toHaveBeenCalledWith({ limit: undefined, offset: undefined, userId: undefined });
    });

    it("users rejects non-GET (405)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: readOnlyAuthAdmin(), shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/auth/users", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "POST" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(405);
    });
});

const USER = { banned: false, email: "a@example.com", id: "u1", role: "user" };

/** A full auth-admin plane with spy-able mutations. */
const authAdmin = (): AuthAdmin => {
    return {
        banUser: vi.fn<NonNullable<AuthAdmin["banUser"]>>(async () => {
            return { ...USER, banned: true };
        }),
        createUser: vi.fn<NonNullable<AuthAdmin["createUser"]>>(async () => USER),
        impersonateUser: vi.fn<NonNullable<AuthAdmin["impersonateUser"]>>(async () => {
            return { expiresAt: 1, token: "tok_u1", user: USER };
        }),
        listSessions: vi.fn<AuthAdmin["listSessions"]>(async () => SESSIONS),
        listUsers: vi.fn<AuthAdmin["listUsers"]>(async () => USERS),
        removeUser: vi.fn<NonNullable<AuthAdmin["removeUser"]>>(async () => undefined),
        revokeUserSession: vi.fn<NonNullable<AuthAdmin["revokeUserSession"]>>(async () => undefined),
        revokeUserSessions: vi.fn<NonNullable<AuthAdmin["revokeUserSessions"]>>(async () => undefined),
        setRole: vi.fn<NonNullable<AuthAdmin["setRole"]>>(async () => {
            return { ...USER, role: "admin" };
        }),
        setUserPassword: vi.fn<NonNullable<AuthAdmin["setUserPassword"]>>(async () => undefined),
        unbanUser: vi.fn<NonNullable<AuthAdmin["unbanUser"]>>(async () => USER),

        capabilities: vi.fn<NonNullable<AuthAdmin["capabilities"]>>(async () => {
            return { accounts: true, admin: true, organization: false, passkey: false, twoFactor: false };
        }),
    };
};

const post = (url: string, body: unknown): Request =>
    new Request(url, { body: JSON.stringify(body), headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, method: "POST" });

describe("createWorker — auth admin mutation endpoints", () => {
    it("forwards search + role filter on the users endpoint", async () => {
        expect.assertions(1);

        const admin = authAdmin();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: admin, shardDO: noopNamespace });

        await worker.fetch(authed("https://app.example/_lunora/admin/auth/users?search=ann&filterField=role&filterValue=admin"), {}, fakeContext);

        expect(admin.listUsers).toHaveBeenCalledWith(expect.objectContaining({ filterField: "role", filterValue: "admin", search: "ann" }));
    });

    it("bans a user via POST and returns the updated row", async () => {
        expect.assertions(2);

        const admin = authAdmin();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: admin, shardDO: noopNamespace });

        const response = await worker.fetch(post("https://app.example/_lunora/admin/auth/users/ban", { reason: "spam", userId: "u1" }), {}, fakeContext);

        expect(response.status).toBe(200);
        expect(admin.banUser).toHaveBeenCalledWith(expect.objectContaining({ reason: "spam", userId: "u1" }));
    });

    it("marks every auth admin reply no-store — they carry session tokens and PII", async () => {
        expect.assertions(3);

        const admin = authAdmin();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: admin, shardDO: noopNamespace });

        // `impersonate` hands back a live session bearer token for an arbitrary user
        // and `users` returns PII. Under `adminGate` (Cloudflare Access) the request
        // carries a cookie/JWT and no `Authorization` header, so RFC 9111's
        // shared-cache suppression does not apply and an intermediary is free to
        // store the reply. The two inline admin routes in `create-worker.ts` already
        // set `no-store`; this plane did not.
        const impersonate = await worker.fetch(post("https://app.example/_lunora/admin/auth/users/impersonate", { userId: "u1" }), {}, fakeContext);

        expect(impersonate.status).toBe(200);
        expect(impersonate.headers.get("cache-control")).toBe("no-store");

        const users = await worker.fetch(authed("https://app.example/_lunora/admin/auth/users"), {}, fakeContext);

        expect(users.headers.get("cache-control")).toBe("no-store");
    });

    it("revokes a single session by id", async () => {
        expect.assertions(2);

        const admin = authAdmin();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: admin, shardDO: noopNamespace });

        const response = await worker.fetch(post("https://app.example/_lunora/admin/auth/sessions/revoke", { sessionId: "s1" }), {}, fakeContext);

        expect(response.status).toBe(200);
        expect(admin.revokeUserSession).toHaveBeenCalledWith({ sessionId: "s1" });
    });

    it("rejects a ban without a userId (400 BAD_REQUEST)", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: authAdmin(), shardDO: noopNamespace });

        const response = await worker.fetch(post("https://app.example/_lunora/admin/auth/users/ban", {}), {}, fakeContext);
        const body: { error: { code: string } } = await response.json();

        expect(response.status).toBe(400);
        expect(body.error.code).toBe("BAD_REQUEST");
    });

    it("rejects a ban without a valid admin bearer (403)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: authAdmin(), shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/auth/users/ban", { body: "{}", headers: { "content-type": "application/json" }, method: "POST" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(403);
    });

    it("maps a known client-input code to its 4xx and an unmapped backend failure to 500", async () => {
        expect.assertions(4);

        const plane = authAdmin();
        const banUser = vi.mocked(plane.banUser as NonNullable<AuthAdmin["banUser"]>);

        banUser.mockImplementationOnce(async () => {
            throw new LunoraError("USER_NOT_FOUND", "nope");
        });
        banUser.mockImplementationOnce(async () => {
            throw new LunoraError("SQLITE_IOERR", "driver exploded");
        });

        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: plane, shardDO: noopNamespace });

        const notFound = await worker.fetch(post("https://app.example/_lunora/admin/auth/users/ban", { userId: "u1" }), {}, fakeContext);

        expect(notFound.status).toBe(404);

        // An unmapped code is a backend failure, not client input — it must
        // read as a server incident (500), never a 400.
        const backend = await worker.fetch(post("https://app.example/_lunora/admin/auth/users/ban", { userId: "u1" }), {}, fakeContext);
        const body: { error: { code: string; message: string } } = await backend.json();

        expect(backend.status).toBe(500);
        expect(body.error.code).toBe("SQLITE_IOERR");
        // The driver detail is logged server-side, never sent to the client.
        expect(body.error.message).not.toContain("driver exploded");

        error.mockRestore();
    });

    it("reports AUTH_OP_NOT_SUPPORTED when the plane omits the mutation", async () => {
        expect.assertions(2);

        // A read-only auth plane satisfies the reads but has no `banUser`.
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: readOnlyAuthAdmin(), shardDO: noopNamespace });

        const response = await worker.fetch(post("https://app.example/_lunora/admin/auth/users/ban", { userId: "u1" }), {}, fakeContext);
        const body: { error: { code: string } } = await response.json();

        expect(response.status).toBe(400);
        expect(body.error.code).toBe("AUTH_OP_NOT_SUPPORTED");
    });

    it("rejects a mutation on the wrong method (405)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: authAdmin(), shardDO: noopNamespace });

        const response = await worker.fetch(authed("https://app.example/_lunora/admin/auth/users/ban"), {}, fakeContext);

        expect(response.status).toBe(405);
    });

    it("returns the plane's capabilities", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: authAdmin(), shardDO: noopNamespace });

        const response = await worker.fetch(authed("https://app.example/_lunora/admin/auth/capabilities"), {}, fakeContext);
        const body: { admin: boolean; organization: boolean } = await response.json();

        expect(body.admin).toBe(true);
        expect(body.organization).toBe(false);
    });

    it("reports AUTH_OP_NOT_SUPPORTED for a plugin op the plane didn't wire", async () => {
        expect.assertions(2);

        // `authAdmin()` has no `listOrganizations` (org plugin not configured).
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: authAdmin(), shardDO: noopNamespace });

        const response = await worker.fetch(authed("https://app.example/_lunora/admin/auth/organizations"), {}, fakeContext);
        const body: { error: { code: string } } = await response.json();

        expect(response.status).toBe(400);
        expect(body.error.code).toBe("AUTH_OP_NOT_SUPPORTED");
    });
});
