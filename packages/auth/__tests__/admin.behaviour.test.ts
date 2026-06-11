import { memoryAdapter } from "better-auth/adapters/memory";
import { beforeEach, describe, expect, it } from "vitest";

import { createAuthAdmin } from "../src/admin";
import { createAuth } from "../src/create-auth";
import { admin } from "../src/plugins";

/**
 * Round-trip behaviour for `createAuthAdmin`, exercised against the real
 * better-auth runtime on an in-memory adapter (no mocks). Confirms each
 * operation talks to `auth.$context` correctly and that the trusted server-side
 * path bypasses better-auth's own admin-session gate — i.e. these calls work
 * with no caller headers, which is the whole point of the admin-token-gated
 * Cirrus endpoints that drive them.
 */

const SECRET = "x".repeat(32);
const STRONG_PASSWORD = "correct horse battery staple";

const seedMemoryDatabase = (): Record<string, unknown[]> => {
    return { account: [], session: [], user: [], verification: [] };
};

describe("createAuthAdmin", () => {
    let database: Record<string, unknown[]>;
    // `any` to reach plugin-contributed endpoints without re-deriving the generic chain.
    let auth: any;
    let adminApi: ReturnType<typeof createAuthAdmin>;

    beforeEach(() => {
        database = seedMemoryDatabase();
        auth = createAuth({
            baseURL: "http://localhost",
            database: memoryAdapter(database),
            emailAndPassword: { enabled: true },
            plugins: [admin()],
            secret: SECRET,
        });
        adminApi = createAuthAdmin(auth);
    });

    const userRow = (id: string): Record<string, unknown> | undefined =>
        database["user"]?.find((row) => (row as { id: string }).id === id) as Record<string, unknown> | undefined;

    it("creates a user (with role + a credential account when a password is given)", async () => {
        expect.assertions(3);

        const user = await adminApi.createUser({ email: "Ada@Example.com", name: "Ada", password: STRONG_PASSWORD, role: "admin" });

        expect(user.email).toBe("ada@example.com");
        expect(user.role).toBe("admin");
        expect(database["account"]?.length).toBe(1);
    });

    it("rejects a duplicate email", async () => {
        expect.assertions(1);

        await adminApi.createUser({ email: "dup@example.com", name: "First" });

        await expect(adminApi.createUser({ email: "dup@example.com", name: "Second" })).rejects.toThrow(/already exists/iu);
    });

    it("lists users with a total and an email search", async () => {
        expect.assertions(3);

        await adminApi.createUser({ email: "ann@example.com", name: "Ann" });
        await adminApi.createUser({ email: "bob@example.com", name: "Bob" });

        const all = await adminApi.listUsers({});

        expect(all.total).toBe(2);
        expect(all.rows).toHaveLength(2);

        const searched = await adminApi.listUsers({ search: "ann" });

        expect(searched.rows.map((row) => row.email)).toEqual(["ann@example.com"]);
    });

    it("bans then unbans a user", async () => {
        expect.assertions(3);

        const user = await adminApi.createUser({ email: "ban@example.com", name: "Ban" });

        await adminApi.banUser({ reason: "spam", userId: user.id });

        expect(userRow(user.id)?.["banned"]).toBe(true);
        expect(userRow(user.id)?.["banReason"]).toBe("spam");

        await adminApi.unbanUser({ userId: user.id });

        expect(userRow(user.id)?.["banned"]).toBe(false);
    });

    it("sets a role", async () => {
        expect.assertions(1);

        const user = await adminApi.createUser({ email: "role@example.com", name: "Role" });

        await adminApi.setRole({ role: "editor", userId: user.id });

        expect(userRow(user.id)?.["role"]).toBe("editor");
    });

    it("rejects a too-short password", async () => {
        expect.assertions(1);

        const user = await adminApi.createUser({ email: "pw@example.com", name: "Pw" });

        await expect(adminApi.setUserPassword({ newPassword: "x", userId: user.id })).rejects.toThrow(/PASSWORD_TOO_SHORT|at least/iu);
    });

    it("mints an impersonation token for a user", async () => {
        expect.assertions(2);

        const user = await adminApi.createUser({ email: "imp@example.com", name: "Imp" });
        const result = await adminApi.impersonateUser({ userId: user.id });

        expect(typeof result.token).toBe("string");
        expect(result.token.length).toBeGreaterThan(0);
    });

    it("never leaks the session token through listSessions", async () => {
        expect.assertions(2);

        const user = await adminApi.createUser({ email: "ses@example.com", name: "Ses" });

        await adminApi.impersonateUser({ userId: user.id });

        const page = await adminApi.listSessions({ userId: user.id });

        expect(page.rows).toHaveLength(1);
        expect(page.rows[0]).not.toHaveProperty("token");
    });

    it("revokes a single session by id and revokes all sessions for a user", async () => {
        expect.assertions(2);

        const user = await adminApi.createUser({ email: "rev@example.com", name: "Rev" });

        await adminApi.impersonateUser({ userId: user.id });
        const before = await adminApi.listSessions({ userId: user.id });

        await adminApi.revokeUserSession({ sessionId: before.rows[0]!.id });

        const afterOne = await adminApi.listSessions({ userId: user.id });

        expect(afterOne.rows).toHaveLength(0);

        await adminApi.impersonateUser({ userId: user.id });
        await adminApi.revokeUserSessions({ userId: user.id });

        const afterAll = await adminApi.listSessions({ userId: user.id });

        expect(afterAll.rows).toHaveLength(0);
    });

    it("removes a user", async () => {
        expect.assertions(1);

        const user = await adminApi.createUser({ email: "del@example.com", name: "Del" });

        await adminApi.removeUser({ userId: user.id });

        expect(userRow(user.id)).toBeUndefined();
    });

    it("reports capabilities from the enabled plugins", async () => {
        expect.assertions(3);

        const capabilities = await adminApi.capabilities();

        expect(capabilities.admin).toBe(true);
        expect(capabilities.organization).toBe(false);
        expect(capabilities.accounts).toBe(true);
    });

    it("honors a features override", async () => {
        expect.assertions(1);

        const restricted = createAuthAdmin(auth, { features: { admin: false } });
        const capabilities = await restricted.capabilities();

        expect(capabilities.admin).toBe(false);
    });

    it("lists linked accounts without leaking token/password material", async () => {
        expect.assertions(3);

        const user = await adminApi.createUser({ email: "acct@example.com", name: "Acct", password: STRONG_PASSWORD });
        const accounts = await adminApi.listAccounts({ userId: user.id });

        expect(accounts).toHaveLength(1);
        expect(accounts[0]?.providerId).toBe("credential");
        expect(accounts[0]).not.toHaveProperty("password");
    });

    it("impersonateUser respects a custom impersonationSeconds TTL", async () => {
        expect.assertions(2);

        const customTtl = 7200; // 2 hours
        const adminWithTtl = createAuthAdmin(auth, { impersonationSeconds: customTtl });
        const user = await adminApi.createUser({ email: "ttl@example.com", name: "Ttl" });

        const before = Date.now();
        const result = await adminWithTtl.impersonateUser({ userId: user.id });
        const after = Date.now();

        // expiresAt must be roughly `customTtl` seconds from now.
        const expectedMin = before + customTtl * 1000;
        const expectedMax = after + customTtl * 1000;

        expect(result.expiresAt).toBeGreaterThanOrEqual(expectedMin);
        expect(result.expiresAt).toBeLessThanOrEqual(expectedMax);
    });

    it("impersonateUser rejects invalid impersonationSeconds values", async () => {
        expect.assertions(3);

        const user = await adminApi.createUser({ email: "invalid-ttl@example.com", name: "Inv" });

        await expect(createAuthAdmin(auth, { impersonationSeconds: 0 }).impersonateUser({ userId: user.id })).rejects.toThrow(/positive finite integer/);

        await expect(createAuthAdmin(auth, { impersonationSeconds: -60 }).impersonateUser({ userId: user.id })).rejects.toThrow(/positive finite integer/);

        await expect(createAuthAdmin(auth, { impersonationSeconds: Number.POSITIVE_INFINITY }).impersonateUser({ userId: user.id })).rejects.toThrow(
            /positive finite integer/,
        );
    });
});
