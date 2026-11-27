import { DatabaseSync } from "node:sqlite";

import { LunoraError } from "@lunora/errors";
import { describe, expect, it, vi } from "vitest";

import { lunoraAuthAdapter } from "../../auth/src/adapter";
import { createAuthAdmin } from "../../auth/src/admin";
import { createAuthAuditReader, createAuthAuditWriter } from "../../auth/src/audit";
import { createAuth } from "../../auth/src/create-auth";
import { apiKey, passkey } from "../../auth/src/plugins";
import type { SqlExecutor } from "../../auth/src/sql-store";
import { createMemoryAuthStore } from "../../auth/src/store";
import type { AuthAdmin, AuthAuditWrite, AuthAuditWriter, ExecutionContextLike } from "../src/create-worker";
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
        deleteApiKey: vi.fn<NonNullable<AuthAdmin["deleteApiKey"]>>(async () => undefined),
        impersonateUser: vi.fn<NonNullable<AuthAdmin["impersonateUser"]>>(async () => {
            return { expiresAt: 1, token: "tok_u1", user: USER };
        }),
        listApiKeys: vi.fn<NonNullable<AuthAdmin["listApiKeys"]>>(async () => [{ id: "k1", name: "ci", referenceId: "u1", start: "lnr_k1" }]),
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
            return { accounts: true, apiKey: false, admin: true, inviteOnly: false, organization: false, passkey: false, twoFactor: false };
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

    it("lists a user's API keys by userId", async () => {
        expect.assertions(2);

        const admin = authAdmin();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: admin, shardDO: noopNamespace });

        const response = await worker.fetch(authed("https://app.example/_lunora/admin/auth/api-keys?userId=u1"), {}, fakeContext);

        expect(response.status).toBe(200);
        expect(admin.listApiKeys).toHaveBeenCalledWith({ userId: "u1" });
    });

    it("revokes an API key by id with a POST", async () => {
        expect.assertions(2);

        const admin = authAdmin();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: admin, shardDO: noopNamespace });

        const response = await worker.fetch(post("https://app.example/_lunora/admin/auth/api-keys/delete", { apiKeyId: "k1" }), {}, fakeContext);

        expect(response.status).toBe(200);
        expect(admin.deleteApiKey).toHaveBeenCalledWith({ apiKeyId: "k1" });
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

    it.each([
        ["LAST_ORGANIZATION_OWNER", "user is the last owner of an organization"],
        ["MEMBERSHIP_CHANGED", "member changed role during its removal"],
    ])("maps %s to 409, a conflict with the organization's current state", async (code, message) => {
        expect.assertions(1);

        const plane = authAdmin();
        vi.mocked(plane.banUser as NonNullable<AuthAdmin["banUser"]>).mockImplementationOnce(async () => {
            throw new LunoraError(code, message);
        });

        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: plane, shardDO: noopNamespace });
        const response = await worker.fetch(post("https://app.example/_lunora/admin/auth/users/ban", { userId: "u1" }), {}, fakeContext);

        expect(response.status).toBe(409);
    });

    it("maps the api-key revoke refusals to 404 and 409", async () => {
        expect.assertions(2);

        const plane = authAdmin();
        const deleteApiKey = vi.mocked(plane.deleteApiKey as NonNullable<AuthAdmin["deleteApiKey"]>);

        deleteApiKey.mockImplementationOnce(async () => {
            throw new LunoraError("API_KEY_NOT_FOUND", "nope");
        });
        deleteApiKey.mockImplementationOnce(async () => {
            throw new LunoraError("API_KEY_STORAGE_UNSUPPORTED", "nope");
        });

        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: plane, shardDO: noopNamespace });
        const url = "https://app.example/_lunora/admin/auth/api-keys/delete";

        const missing = await worker.fetch(post(url, { apiKeyId: "k1" }), {}, fakeContext);
        const unsupported = await worker.fetch(post(url, { apiKeyId: "k1" }), {}, fakeContext);

        expect(missing.status).toBe(404);
        expect(unsupported.status).toBe(409);
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

/** The real `@lunora/auth` writer over an in-memory database, read back through its reader: what the trail stores. */
const sqliteTrail = (auth: Parameters<typeof createAuthAuditWriter>[1]): { read: () => Promise<unknown[]>; writer: AuthAuditWriter } => {
    const database = new DatabaseSync(":memory:");
    const executor: SqlExecutor = {
        all: (sql, parameters) => Promise.resolve(database.prepare(sql).all(...(parameters as never[])) as Record<string, unknown>[]),
        run: (sql, parameters) => {
            database.prepare(sql).run(...(parameters as never[]));

            return Promise.resolve();
        },
    };

    return { read: () => createAuthAuditReader(executor).read({}), writer: createAuthAuditWriter(executor, auth) };
};

/** A writer that keeps every row it is handed, so a test can read what the trail would hold. */
const recordingWriter = (): AuthAuditWriter & { rows: AuthAuditWrite[] } => {
    const rows: AuthAuditWrite[] = [];

    return {
        rows,
        write: async (entry) => {
            rows.push(entry);
        },
    };
};

/** The mutation plane plus the organization and two-factor ops, so each method class has a route to drive. */
const auditedAuthAdmin = (): AuthAdmin => {
    return {
        ...authAdmin(),
        addMember: vi.fn<NonNullable<AuthAdmin["addMember"]>>(async () => {
            return { id: "m9", organizationId: "o1", userId: "u1" };
        }),
        createOrganization: vi.fn<NonNullable<AuthAdmin["createOrganization"]>>(async () => {
            return { id: "o9", name: "Acme" };
        }),
        disableTwoFactor: vi.fn<NonNullable<AuthAdmin["disableTwoFactor"]>>(async () => undefined),
        inviteMember: vi.fn<NonNullable<AuthAdmin["inviteMember"]>>(async () => {
            return { id: "i9" };
        }),
    };
};

const AUTH = "https://app.example/_lunora/admin/auth";

const FIXTURE_PASSWORD = "hunter2-secret"; // secret-scanner:allow -- fake test fixture, not a real credential

describe("createWorker — auth admin audit trail", () => {
    it.each([
        [
            "user lifecycle",
            "users/create",
            { email: "new@example.com", name: "New", password: FIXTURE_PASSWORD }, // secret-scanner:allow -- fake test fixture, not a real credential
            "admin-user-create",
            // The plane saved its default role; the row says which.
            { role: "user", targetUserId: "u1" },
            {
                // The address the plane saved (the mock's), not the one asked for.
                targetEmail: "a@example.com",
            },
        ],
        ["user ban", "users/ban", { reason: "spam", userId: "u1" }, "admin-user-ban", { targetUserId: "u1" }],
        ["role", "users/role", { role: "admin", userId: "u1" }, "admin-role-change", { role: "admin", targetUserId: "u1" }],
        ["password", "users/password", { newPassword: FIXTURE_PASSWORD, userId: "u1" }, "admin-password-set", { targetUserId: "u1" }], // secret-scanner:allow -- fake test fixture, not a real credential
        ["impersonate", "users/impersonate", { userId: "u1" }, "admin-impersonate-start", { targetUserId: "u1" }],
        ["sessions", "sessions/revoke-all", { userId: "u1" }, "admin-session-revoke", { targetUserId: "u1" }],
        ["organization", "organizations/create", { name: "Acme" }, "org-create", { organizationId: "o9" }],
        [
            "membership",
            "organizations/members/add",
            { organizationId: "o1", role: "member", userId: "u1" },
            "org-member-add",
            {
                memberId: "m9",
                organizationId: "o1",
                role: "member",
                targetUserId: "u1",
            },
        ],
        ["two-factor", "two-factor/disable", { userId: "u1" }, "mfa-disable", { targetUserId: "u1" }],
        ["api key", "api-keys/delete", { apiKeyId: "k1" }, "api-key-delete", { keyId: "k1" }],
    ])("records one %s mutation with its event, target and actor", async (_class, route, body, event, ids, columns?: Partial<AuthAuditWrite>) => {
        expect.assertions(2);

        const writer = recordingWriter();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: auditedAuthAdmin(), authAuditWriter: writer, shardDO: noopNamespace });

        const response = await worker.fetch(post(`${AUTH}/${route}`, body), {}, fakeContext);

        expect(response.status).toBe(200);
        expect(writer.rows).toStrictEqual([
            { actorId: "admin:root", detail: { path: `/_lunora/admin/auth/${route}`, ...ids }, event, outcome: "success", ts: expect.any(Number), ...columns },
        ]);
    });

    it.each([
        ["api key", [apiKey()], "api-keys/delete", "apiKeyId", "api-key-delete", "API_KEY_NOT_FOUND"],
        ["passkey", [passkey()], "passkeys/delete", "passkeyId", "passkey-remove", "PASSKEY_NOT_FOUND"],
        ["session", [], "sessions/revoke", "sessionId", "admin-session-revoke", "SESSION_NOT_FOUND"],
    ])("answers 404 for a revoke naming a missing %s and records a failure row without the id it named", async (_kind, plugins, route, field, event, code) => {
        expect.assertions(3);

        // The real plane and writer, so the revoke answers as @lunora/auth does for an id that matches nothing, and the
        // row is what the trail would store. The id stands in for a key pasted into the wrong field.
        const auth = createAuth({ baseURL: "http://localhost", database: lunoraAuthAdapter(createMemoryAuthStore()), plugins, secret: "x".repeat(32) });
        const named = "f".repeat(64);
        const trail = sqliteTrail(auth);
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: createAuthAdmin(auth), authAuditWriter: trail.writer, shardDO: noopNamespace });

        const response = await worker.fetch(post(`${AUTH}/${route}`, { [field]: named }), {}, fakeContext);
        const rows = await trail.read();

        expect(response.status).toBe(404);
        expect(rows).toStrictEqual([
            expect.objectContaining({
                actorId: "admin:root",
                detail: expect.objectContaining({ code, path: `/_lunora/admin/auth/${route}` }),
                event,
                outcome: "failure",
            }),
        ]);
        expect(JSON.stringify(rows)).not.toContain(named);
    });

    it("records a revoked invitation under the address the plane revoked, and a new organization's owner", async () => {
        expect.assertions(2);

        const plane: AuthAdmin = {
            ...auditedAuthAdmin(),
            revokeSignUpInvitation: vi.fn<NonNullable<AuthAdmin["revokeSignUpInvitation"]>>(async () => undefined),
        };
        const writer = recordingWriter();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: plane, authAuditWriter: writer, shardDO: noopNamespace });

        await worker.fetch(post(`${AUTH}/sign-up-invitations/revoke`, { email: " User@Example.COM " }), {}, fakeContext);
        await worker.fetch(post(`${AUTH}/organizations/create`, { name: "Acme", ownerId: "u7" }), {}, fakeContext);

        expect(writer.rows[0]?.targetEmail).toBe("user@example.com");
        expect(writer.rows[1]?.detail).toMatchObject({ organizationId: "o9", targetUserId: "u7" });
    });

    it("records the persisted roles of a multi-role grant", async () => {
        expect.assertions(2);

        const plane: AuthAdmin = {
            ...auditedAuthAdmin(),
            updateMemberRole: vi.fn<NonNullable<AuthAdmin["updateMemberRole"]>>(async () => {
                return { id: "m1", organizationId: "o1", userId: "u1" };
            }),
        };

        vi.mocked(plane.setRole as NonNullable<AuthAdmin["setRole"]>).mockImplementationOnce(async () => {
            return { ...USER, role: "admin,support" };
        });

        const writer = recordingWriter();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: plane, authAuditWriter: writer, shardDO: noopNamespace });

        await worker.fetch(post(`${AUTH}/users/role`, { role: ["admin", "support"], userId: "u1" }), {}, fakeContext);
        await worker.fetch(post(`${AUTH}/organizations/members/role`, { memberId: "m1", role: ["admin", "billing"] }), {}, fakeContext);

        expect(writer.rows[0]?.detail).toMatchObject({ role: "admin,support", targetUserId: "u1" });
        expect(writer.rows[1]?.detail).toMatchObject({ memberId: "m1", role: "admin,billing" });
    });

    it("records the organization an item update returns when the request names only the item", async () => {
        expect.assertions(3);

        const plane: AuthAdmin = {
            ...auditedAuthAdmin(),
            updateMemberRole: vi.fn<NonNullable<AuthAdmin["updateMemberRole"]>>(async () => {
                return { id: "m1", organizationId: "o1", role: "admin", userId: "u1" };
            }),
            updateOrgRole: vi.fn<NonNullable<AuthAdmin["updateOrgRole"]>>(async () => {
                return { id: "r1", organizationId: "o3", permission: {}, role: "editor" };
            }),
            updateTeam: vi.fn<NonNullable<AuthAdmin["updateTeam"]>>(async () => {
                return { id: "t1", name: "Ops", organizationId: "o2" };
            }),
        };
        const writer = recordingWriter();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: plane, authAuditWriter: writer, shardDO: noopNamespace });

        await worker.fetch(post(`${AUTH}/organizations/members/role`, { memberId: "m1", role: "admin" }), {}, fakeContext);
        await worker.fetch(post(`${AUTH}/organizations/teams/update`, { name: "Ops", teamId: "t1" }), {}, fakeContext);
        await worker.fetch(post(`${AUTH}/organizations/roles/update`, { permission: { project: ["read"] }, roleId: "r1" }), {}, fakeContext);

        expect(writer.rows[0]?.detail).toMatchObject({ memberId: "m1", organizationId: "o1" });
        expect(writer.rows[1]?.detail).toMatchObject({ organizationId: "o2", teamId: "t1" });
        expect(writer.rows[2]?.detail).toMatchObject({ organizationId: "o3", roleId: "r1" });
    });

    it("records the address a created user was saved under, the caller's address and agent, and an org role's name", async () => {
        expect.assertions(3);

        const plane: AuthAdmin = {
            ...auditedAuthAdmin(),
            createOrgRole: vi.fn<NonNullable<AuthAdmin["createOrgRole"]>>(async () => {
                return { id: "r9", organizationId: "o1", permission: {}, role: "editor" };
            }),
        };

        vi.mocked(plane.createUser as NonNullable<AuthAdmin["createUser"]>).mockImplementationOnce(async () => {
            return { ...USER, email: "saved@example.com" };
        });

        const writer = recordingWriter();
        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            authAdmin: plane,
            authAuditWriter: writer,
            shardDO: noopNamespace,
            trustedClientIpHeader: "x-real-ip",
        });
        const withOrigin = (request: Request): Request => {
            request.headers.set("x-real-ip", "203.0.113.9");
            request.headers.set("user-agent", "ops-cli/1");

            return request;
        };

        await worker.fetch(
            withOrigin(post(`${AUTH}/users/create`, { data: { email: "saved@example.com" }, email: "asked@example.com", name: "New" })),
            {},
            fakeContext,
        );
        await worker.fetch(
            post(`${AUTH}/organizations/roles/create`, { organizationId: "o1", permission: { doc: ["read"] }, role: "editor" }),
            {},
            fakeContext,
        );

        expect(writer.rows[0]).toMatchObject({ ip: "203.0.113.9", targetEmail: "saved@example.com", userAgent: "ops-cli/1" });
        expect(writer.rows[1]?.detail).toMatchObject({ roleId: "r9", roleName: "editor" });
        expect(writer.rows[1]?.detail).not.toHaveProperty("role");
    });

    it("records the role a member was added or invited with when the request named none", async () => {
        expect.assertions(2);

        const plane: AuthAdmin = {
            ...auditedAuthAdmin(),
            addMember: vi.fn<NonNullable<AuthAdmin["addMember"]>>(async () => {
                return { id: "m9", organizationId: "o1", role: "member", userId: "u1" };
            }),
            inviteMember: vi.fn<NonNullable<AuthAdmin["inviteMember"]>>(async () => {
                return { id: "i9", role: "member" };
            }),
        };
        const writer = recordingWriter();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: plane, authAuditWriter: writer, shardDO: noopNamespace });

        await worker.fetch(post(`${AUTH}/organizations/members/add`, { organizationId: "o1", userId: "u1" }), {}, fakeContext);
        await worker.fetch(post(`${AUTH}/organizations/members/invite`, { email: "guest@example.com", organizationId: "o1" }), {}, fakeContext);

        expect(writer.rows[0]?.detail).toMatchObject({ memberId: "m9", role: "member" });
        expect(writer.rows[1]?.detail).toMatchObject({ invitationId: "i9", role: "member" });
    });

    it("records the role a created user was saved with when `data` overrides it", async () => {
        expect.assertions(1);

        const plane = auditedAuthAdmin();

        vi.mocked(plane.createUser as NonNullable<AuthAdmin["createUser"]>).mockImplementationOnce(async () => {
            return { ...USER, role: "admin" };
        });

        const writer = recordingWriter();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: plane, authAuditWriter: writer, shardDO: noopNamespace });

        await worker.fetch(post(`${AUTH}/users/create`, { data: { role: "admin" }, email: "new@example.com", name: "New", role: "user" }), {}, fakeContext);

        expect(writer.rows[0]?.detail).toMatchObject({ role: "admin", targetUserId: "u1" });
    });

    it("records `data`'s role and address, which the save keeps, when the created user omits them", async () => {
        expect.assertions(2);

        const plane = auditedAuthAdmin();

        // `AuthAdminUser.role` and `.email` are optional, so a conforming plane may return neither.
        vi.mocked(plane.createUser as NonNullable<AuthAdmin["createUser"]>).mockImplementationOnce(async () => {
            return { id: "u1" };
        });

        const writer = recordingWriter();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: plane, authAuditWriter: writer, shardDO: noopNamespace });

        await worker.fetch(
            post(`${AUTH}/users/create`, { data: { email: "saved@example.com", role: "admin" }, email: "asked@example.com", name: "New", role: "user" }),
            {},
            fakeContext,
        );

        expect(writer.rows[0]?.detail).toMatchObject({ role: "admin", targetUserId: "u1" });
        expect(writer.rows[0]).toMatchObject({ targetEmail: "saved@example.com" });
    });

    it("names the sign-up invitation it created", async () => {
        expect.assertions(1);

        const plane: AuthAdmin = {
            ...auditedAuthAdmin(),
            createSignUpInvitation: vi.fn<NonNullable<AuthAdmin["createSignUpInvitation"]>>(async () => {
                return { email: "guest@example.com", id: "si9" };
            }),
        };

        const writer = recordingWriter();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: plane, authAuditWriter: writer, shardDO: noopNamespace });

        await worker.fetch(post(`${AUTH}/sign-up-invitations/create`, { email: "guest@example.com" }), {}, fakeContext);

        expect(writer.rows).toStrictEqual([
            expect.objectContaining({
                detail: { invitationId: "si9", path: "/_lunora/admin/auth/sign-up-invitations/create" },
                event: "sign-up-invitation-create",
                targetEmail: "guest@example.com",
            }),
        ]);
    });

    it("names an invitation's target by address, outside the redacted detail", async () => {
        expect.assertions(1);

        const writer = recordingWriter();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: auditedAuthAdmin(), authAuditWriter: writer, shardDO: noopNamespace });

        await worker.fetch(post(`${AUTH}/organizations/members/invite`, { email: "guest@example.com", organizationId: "o1" }), {}, fakeContext);

        expect(writer.rows).toStrictEqual([
            expect.objectContaining({
                detail: { invitationId: "i9", organizationId: "o1", path: "/_lunora/admin/auth/organizations/members/invite" },
                event: "org-invitation-create",
                targetEmail: "guest@example.com",
            }),
        ]);
    });

    it("records nothing for a read", async () => {
        expect.assertions(2);

        const writer = recordingWriter();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: auditedAuthAdmin(), authAuditWriter: writer, shardDO: noopNamespace });

        const response = await worker.fetch(authed(`${AUTH}/users`), {}, fakeContext);

        expect(response.status).toBe(200);
        expect(writer.rows).toHaveLength(0);
    });

    it("records one failure row with the error code when the operation fails", async () => {
        expect.assertions(2);

        const plane = auditedAuthAdmin();

        vi.mocked(plane.banUser as NonNullable<AuthAdmin["banUser"]>).mockImplementationOnce(async () => {
            throw new LunoraError("USER_NOT_FOUND", "nope");
        });

        const writer = recordingWriter();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: plane, authAuditWriter: writer, shardDO: noopNamespace });

        const response = await worker.fetch(post(`${AUTH}/users/ban`, { userId: "u1" }), {}, fakeContext);

        expect(response.status).toBe(404);
        expect(writer.rows).toStrictEqual([
            {
                actorId: "admin:root",
                detail: { code: "USER_NOT_FOUND", path: "/_lunora/admin/auth/users/ban", targetUserId: "u1" },
                event: "admin-user-ban",
                outcome: "failure",
                ts: expect.any(Number),
            },
        ]);
    });

    it("records a backend failure as a 500 failure row without the backend's message", async () => {
        expect.assertions(3);

        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const plane = auditedAuthAdmin();

        vi.mocked(plane.banUser as NonNullable<AuthAdmin["banUser"]>).mockImplementationOnce(async () => {
            throw Object.assign(new Error("D1_ERROR: no such table: user_internal"), { code: "D1_ERROR" });
        });

        const writer = recordingWriter();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: plane, authAuditWriter: writer, shardDO: noopNamespace });

        const response = await worker.fetch(post(`${AUTH}/users/ban`, { userId: "u1" }), {}, fakeContext);

        error.mockRestore();

        expect(response.status).toBe(500);
        expect(writer.rows).toStrictEqual([expect.objectContaining({ detail: expect.objectContaining({ code: "D1_ERROR" }), outcome: "failure" })]);
        expect(JSON.stringify(writer.rows)).not.toContain("user_internal");
    });

    it("records nothing for a request without an admin credential", async () => {
        expect.assertions(2);

        const writer = recordingWriter();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: auditedAuthAdmin(), authAuditWriter: writer, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request(`${AUTH}/users/ban`, { body: JSON.stringify({ userId: "u1" }), headers: { "content-type": "application/json" }, method: "POST" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(403);
        expect(writer.rows).toHaveLength(0);
    });

    it("never writes the password, the minted session token or the admin bearer", async () => {
        expect.assertions(4);

        const writer = recordingWriter();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: auditedAuthAdmin(), authAuditWriter: writer, shardDO: noopNamespace });

        await worker.fetch(post(`${AUTH}/users/password`, { newPassword: FIXTURE_PASSWORD, userId: "u1" }), {}, fakeContext); // secret-scanner:allow -- fake test fixture, not a real credential
        await worker.fetch(post(`${AUTH}/users/create`, { email: "new@example.com", name: "New", password: FIXTURE_PASSWORD }), {}, fakeContext); // secret-scanner:allow -- fake test fixture, not a real credential
        await worker.fetch(post(`${AUTH}/users/impersonate`, { userId: "u1" }), {}, fakeContext);

        const written = JSON.stringify(writer.rows);

        expect(writer.rows).toHaveLength(3);
        expect(written).not.toContain(FIXTURE_PASSWORD);
        expect(written).not.toContain("tok_u1");
        expect(written).not.toContain(ADMIN_TOKEN);
    });

    it("still answers the operation when the audit write fails", async () => {
        expect.assertions(3);

        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const plane = auditedAuthAdmin();
        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            authAdmin: plane,
            authAuditWriter: {
                write: async () => {
                    throw new Error("D1 unavailable");
                },
            },
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(post(`${AUTH}/users/ban`, { userId: "u1" }), {}, fakeContext);

        expect(response.status).toBe(200);
        expect(plane.banUser).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1" }));
        expect(error).toHaveBeenCalledWith("[lunora] auth admin audit write failed:", expect.any(Error));

        error.mockRestore();
    });

    it("answers a failed operation with its own error when the audit write fails too", async () => {
        expect.assertions(2);

        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const plane = auditedAuthAdmin();

        vi.mocked(plane.banUser as NonNullable<AuthAdmin["banUser"]>).mockImplementationOnce(async () => {
            throw new LunoraError("USER_NOT_FOUND", "nope");
        });

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            authAdmin: plane,
            authAuditWriter: {
                write: async () => {
                    throw new Error("D1 unavailable");
                },
            },
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(post(`${AUTH}/users/ban`, { userId: "u1" }), {}, fakeContext);

        expect(response.status).toBe(404);
        expect(error).toHaveBeenCalledWith("[lunora] auth admin audit write failed:", expect.any(Error));

        error.mockRestore();
    });

    it("serves every admin route without a writer", async () => {
        expect.assertions(3);

        const plane = auditedAuthAdmin();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAdmin: plane, shardDO: noopNamespace });

        const ban = await worker.fetch(post(`${AUTH}/users/ban`, { userId: "u1" }), {}, fakeContext);
        const impersonate = await worker.fetch(post(`${AUTH}/users/impersonate`, { userId: "u1" }), {}, fakeContext);
        const users = await worker.fetch(authed(`${AUTH}/users`), {}, fakeContext);

        expect(ban.status).toBe(200);
        expect(impersonate.status).toBe(200);
        expect(users.status).toBe(200);
    });
});
