import { memoryAdapter } from "better-auth/adapters/memory";
import { beforeEach, describe, expect, it } from "vitest";

import { createAuthAdmin } from "../src/admin";
import { createAuth } from "../src/create-auth";
import { admin, deviceAuthorization, jwt, oauthProvider, organization, twoFactor } from "../src/plugins";

/**
 * Round-trip behaviour for `createAuthAdmin`, exercised against the real
 * better-auth runtime on an in-memory adapter (no mocks). Confirms each
 * operation talks to `auth.$context` correctly and that the trusted server-side
 * path bypasses better-auth's own admin-session gate — i.e. these calls work
 * with no caller headers, which is the whole point of the admin-token-gated
 * Lunora endpoints that drive them.
 */

const SECRET = "x".repeat(32);
const STRONG_PASSWORD = "correct horse battery staple";

const seedMemoryDatabase = (): Record<string, unknown[]> => {
    return { account: [], session: [], user: [], verification: [] };
};

/** The `member` row id for a user in one organization; throws when absent so tests stay straight-line. */
const memberIdOf = (database: Record<string, unknown[]>, userId: string, organizationId: string): string => {
    const row = (database["member"] as { id: string; organizationId: string; userId: string }[]).find(
        (candidate) => candidate.userId === userId && candidate.organizationId === organizationId,
    );

    if (!row) {
        throw new Error(`no member row for user ${userId} in organization ${organizationId}`);
    }

    return row.id;
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

    it("clears a stale banExpires when a temp ban is escalated to a permanent ban", async () => {
        expect.assertions(2);

        const user = await adminApi.createUser({ email: "escalate@example.com", name: "Esc" });

        // Temp ban sets banExpires; escalating to a permanent ban (no expiresInSeconds)
        // must null it out, else the "permanent" ban silently lapses after the first expiry.
        await adminApi.banUser({ expiresInSeconds: 3600, reason: "temp", userId: user.id });

        expect(userRow(user.id)?.["banExpires"] ?? null).not.toBeNull();

        await adminApi.banUser({ reason: "permanent", userId: user.id });

        expect(userRow(user.id)?.["banExpires"] ?? null).toBeNull();
    });

    it("rejects a non-positive expiresInSeconds instead of silently making the ban permanent", async () => {
        expect.assertions(1);

        const user = await adminApi.createUser({ email: "negban@example.com", name: "Neg" });

        await expect(adminApi.banUser({ expiresInSeconds: -100, userId: user.id })).rejects.toThrow(/INVALID_BAN_SECONDS|positive/iu);
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

    const credentialAccounts = (userId: string): Record<string, unknown>[] =>
        (database["account"] ?? []).filter((row) => {
            const account = row as { providerId?: string; userId?: string };

            return account.userId === userId && account.providerId === "credential";
        }) as Record<string, unknown>[];

    it("creates the credential account when setting a password for a user without one", async () => {
        expect.assertions(3);

        const user = await adminApi.createUser({ email: "nopw@example.com", name: "NoPw" });

        expect(credentialAccounts(user.id)).toHaveLength(0);

        await adminApi.setUserPassword({ newPassword: STRONG_PASSWORD, userId: user.id });

        const accounts = credentialAccounts(user.id);

        expect(accounts).toHaveLength(1);
        expect(typeof accounts[0]?.["password"]).toBe("string");
    });

    it("rejects setting a password for an unknown user", async () => {
        expect.assertions(1);

        await expect(adminApi.setUserPassword({ newPassword: STRONG_PASSWORD, userId: "no-such-user" })).rejects.toThrow(/USER_NOT_FOUND|not found/iu);
    });

    it("updates the existing credential account without adding a second one", async () => {
        expect.assertions(3);

        const user = await adminApi.createUser({ email: "haspw@example.com", name: "HasPw", password: STRONG_PASSWORD });
        const before = credentialAccounts(user.id)[0]?.["password"];

        await adminApi.setUserPassword({ newPassword: "another sound password", userId: user.id }); // gitleaks:allow -- test fixture password, not a real secret

        const accounts = credentialAccounts(user.id);

        expect(accounts).toHaveLength(1);
        expect(typeof accounts[0]?.["password"]).toBe("string");
        expect(accounts[0]?.["password"]).not.toBe(before);
    });

    it("refuses to plant a credential account on a deployment with email+password disabled", async () => {
        expect.assertions(2);

        const oauthOnlyDatabase = seedMemoryDatabase();
        const oauthOnlyAuth = createAuth({
            baseURL: "http://localhost",
            database: memoryAdapter(oauthOnlyDatabase),
            plugins: [admin()],
            secret: SECRET,
        });
        const oauthOnlyAdmin = createAuthAdmin(oauthOnlyAuth);

        const user = await oauthOnlyAdmin.createUser({ email: "oauthonly@example.com", name: "OAuthOnly" });

        // Creating one here would go live the day email+password is switched on.
        await expect(oauthOnlyAdmin.setUserPassword({ newPassword: STRONG_PASSWORD, userId: user.id })).rejects.toThrow(/EMAIL_PASSWORD_DISABLED|disabled/iu);
        expect(oauthOnlyDatabase["account"]).toHaveLength(0);
    });

    /** Persisted session rows for a user, newest last, as better-auth wrote them. */
    const sessionRows = (userId: string): Record<string, unknown>[] =>
        (database["session"] ?? []).filter((row) => (row as { userId: string }).userId === userId) as Record<string, unknown>[];

    const asMillis = (value: unknown): number => (value instanceof Date ? value.getTime() : new Date(String(value)).getTime());

    it("mints an impersonation token that IS a freshly persisted session's token", async () => {
        expect.assertions(6);

        const user = await adminApi.createUser({ email: "imp@example.com", name: "Imp" });
        const first = await adminApi.impersonateUser({ userId: user.id });
        const second = await adminApi.impersonateUser({ userId: user.id });

        const rows = sessionRows(user.id);

        // Exactly the two sessions just minted, and the returned credentials are exactly their
        // stored tokens — not a value the caller could have derived (the user id) and not a
        // constant that would impersonate everyone.
        expect(rows).toHaveLength(2);
        expect(new Set(rows.map((row) => row["token"]))).toStrictEqual(new Set([first.token, second.token]));
        expect(first.token).not.toBe(second.token);
        expect(first.token).not.toBe(user.id);
        expect(first.user.id).toBe(user.id);
        // The session is marked as an impersonation, not an ordinary login.
        expect(rows.every((row) => row["impersonatedBy"] !== undefined && row["impersonatedBy"] !== null)).toBe(true);
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

    it("removes a user cleanly when no plugin tables exist", async () => {
        expect.assertions(1);

        // The default harness has no organization/two-factor/passkey plugins,
        // so every cascade gate must skip rather than throw.
        const user = await adminApi.createUser({ email: "noplugins@example.com", name: "NoPlugins" });

        await expect(adminApi.removeUser({ userId: user.id })).resolves.toBeUndefined();
    });

    it("cascades removeUser over user-keyed plugin tables", async () => {
        expect.assertions(5);

        const pluginDatabase: Record<string, unknown[]> = {
            ...seedMemoryDatabase(),
            invitation: [],
            member: [],
            organization: [],
            team: [],
            teamMember: [],
            twoFactor: [],
        };
        const pluginAuth = createAuth({
            baseURL: "http://localhost",
            database: memoryAdapter(pluginDatabase),
            emailAndPassword: { enabled: true },
            plugins: [admin(), organization({ teams: { enabled: true } }), twoFactor()],
            secret: SECRET,
        });
        const pluginAdmin = createAuthAdmin(pluginAuth);

        const user = await pluginAdmin.createUser({ email: "cascade@example.com", name: "Cascade" });
        const survivor = await pluginAdmin.createUser({ email: "stays@example.com", name: "Stays" });

        const org = await pluginAdmin.createOrganization({ name: "Cascade Org", ownerId: user.id });

        // A second owner, so removing `user` doesn't trip the last-owner guard.
        await pluginAdmin.addMember({ organizationId: org.id, role: "owner", userId: survivor.id });
        await pluginAdmin.inviteMember({ email: "guest@example.com", inviterId: user.id, organizationId: org.id });

        // The harness has no endpoint-level 2FA/team enrolment; seed the
        // user-keyed rows directly — the cascade only cares about the rows.
        pluginDatabase["twoFactor"]?.push({ backupCodes: "codes", id: "tf1", secret: "totp-secret", userId: user.id });
        pluginDatabase["teamMember"]?.push({ createdAt: new Date(), id: "tm1", teamId: "team1", userId: user.id });

        await pluginAdmin.removeUser({ userId: user.id });

        const rowsFor = (model: string, field: string): unknown[] =>
            (pluginDatabase[model] ?? []).filter((row) => (row as Record<string, unknown>)[field] === user.id);

        expect(rowsFor("member", "userId")).toHaveLength(0);
        expect(rowsFor("teamMember", "userId")).toHaveLength(0);
        expect(rowsFor("twoFactor", "userId")).toHaveLength(0);
        expect(rowsFor("invitation", "inviterId")).toHaveLength(0);

        // Scoped strictly to the removed user: the survivor's membership stays.
        expect((pluginDatabase["member"] ?? []).filter((row) => (row as Record<string, unknown>)["userId"] === survivor.id)).toHaveLength(1);
    });

    it("cascades removeUser over the OAuth-provider credential tables", async () => {
        expect.assertions(5);

        const oauthDatabase: Record<string, unknown[]> = {
            ...seedMemoryDatabase(),
            deviceCode: [],
            oauthAccessToken: [],
            oauthClient: [],
            oauthConsent: [],
            oauthRefreshToken: [],
        };
        const oauthAuth = createAuth({
            baseURL: "http://localhost",
            database: memoryAdapter(oauthDatabase),
            emailAndPassword: { enabled: true },
            plugins: [admin(), jwt(), oauthProvider({ consentPage: "/consent", loginPage: "/sign-in" }), deviceAuthorization()],
            secret: SECRET,
        });
        const oauthAdmin = createAuthAdmin(oauthAuth);

        const user = await oauthAdmin.createUser({ email: "tokens@example.com", name: "Tokens" });

        // Issuing these needs a full third-party authorization dance; the rows are
        // what the cascade acts on. None of these declare onDelete in better-auth's
        // schema, so nothing else would ever remove them.
        oauthDatabase["oauthAccessToken"]?.push({ accessToken: "at-live", clientId: "c1", id: "at1", userId: user.id });
        oauthDatabase["oauthRefreshToken"]?.push({ clientId: "c1", id: "rt1", refreshToken: "rt-live", userId: user.id });
        oauthDatabase["oauthConsent"]?.push({ clientId: "c1", consentGiven: true, id: "oc1", userId: user.id });
        oauthDatabase["deviceCode"]?.push({ deviceCode: "dc", id: "dc1", userCode: "ABCD", userId: user.id });
        // A client this user registered belongs to everyone using that app — it stays.
        oauthDatabase["oauthClient"]?.push({ clientId: "c1", id: "cl1", userId: user.id });

        await oauthAdmin.removeUser({ userId: user.id });

        expect(oauthDatabase["oauthAccessToken"]).toHaveLength(0);
        expect(oauthDatabase["oauthRefreshToken"]).toHaveLength(0);
        expect(oauthDatabase["oauthConsent"]).toHaveLength(0);
        expect(oauthDatabase["deviceCode"]).toHaveLength(0);
        expect(oauthDatabase["oauthClient"]).toHaveLength(1);
    });

    it("refuses to remove the last owner of an organization instead of orphaning it", async () => {
        expect.assertions(3);

        const orgDatabase: Record<string, unknown[]> = { ...seedMemoryDatabase(), invitation: [], member: [], organization: [] };
        const orgAuth = createAuth({
            baseURL: "http://localhost",
            database: memoryAdapter(orgDatabase),
            emailAndPassword: { enabled: true },
            plugins: [admin(), organization()],
            secret: SECRET,
        });
        const orgAdmin = createAuthAdmin(orgAuth);

        const owner = await orgAdmin.createUser({ email: "sole@example.com", name: "Sole" });
        await orgAdmin.createOrganization({ name: "Sole Owner Co", ownerId: owner.id });

        await expect(orgAdmin.removeUser({ userId: owner.id })).rejects.toThrow(/LAST_ORGANIZATION_OWNER|last owner/iu);

        // Refused, not half-applied: the user and their membership both survive.
        expect(orgDatabase["user"]).toHaveLength(1);
        expect(orgDatabase["member"]).toHaveLength(1);
    });

    it("removes an org member who is not the last owner", async () => {
        expect.assertions(2);

        const orgDatabase: Record<string, unknown[]> = { ...seedMemoryDatabase(), invitation: [], member: [], organization: [] };
        const orgAuth = createAuth({
            baseURL: "http://localhost",
            database: memoryAdapter(orgDatabase),
            emailAndPassword: { enabled: true },
            plugins: [admin(), organization()],
            secret: SECRET,
        });
        const orgAdmin = createAuthAdmin(orgAuth);

        const owner = await orgAdmin.createUser({ email: "keeps@example.com", name: "Keeps" });
        const plain = await orgAdmin.createUser({ email: "plain@example.com", name: "Plain" });
        const org = await orgAdmin.createOrganization({ name: "Two Person Co", ownerId: owner.id });

        await orgAdmin.addMember({ organizationId: org.id, userId: plain.id });

        await expect(orgAdmin.removeUser({ userId: plain.id })).resolves.toBeUndefined();
        expect(orgDatabase["member"]).toHaveLength(1);
    });

    /** An org-enabled plane over an in-memory database, with the `member` table present. */
    const createOrgFixture = (tables: Record<string, unknown[]> = {}) => {
        const orgDatabase: Record<string, unknown[]> = { ...seedMemoryDatabase(), invitation: [], member: [], organization: [], ...tables };
        const orgAuth = createAuth({
            baseURL: "http://localhost",
            database: memoryAdapter(orgDatabase),
            emailAndPassword: { enabled: true },
            plugins: [admin(), organization()],
            secret: SECRET,
        });

        return { orgAdmin: createAuthAdmin(orgAuth), orgDatabase };
    };

    it("refuses removeMember on the sole owner of an organization and keeps the row", async () => {
        expect.assertions(2);

        const { orgAdmin, orgDatabase } = createOrgFixture();
        const owner = await orgAdmin.createUser({ email: "solo-remove@example.com", name: "SoloRemove" });
        const org = await orgAdmin.createOrganization({ name: "Solo Remove Co", ownerId: owner.id });

        await expect(orgAdmin.removeMember({ memberId: memberIdOf(orgDatabase, owner.id, org.id) })).rejects.toThrow(/LAST_ORGANIZATION_OWNER|last owner/iu);
        expect(orgDatabase["member"]).toHaveLength(1);
    });

    it("refuses updateMemberRole demoting the sole owner and keeps the owner role", async () => {
        expect.assertions(2);

        const { orgAdmin, orgDatabase } = createOrgFixture();
        const owner = await orgAdmin.createUser({ email: "solo-demote@example.com", name: "SoloDemote" });
        const org = await orgAdmin.createOrganization({ name: "Solo Demote Co", ownerId: owner.id });
        const memberId = memberIdOf(orgDatabase, owner.id, org.id);

        await expect(orgAdmin.updateMemberRole({ memberId, role: "member" })).rejects.toThrow(/LAST_ORGANIZATION_OWNER|last owner/iu);

        const row = (orgDatabase["member"] as { id: string; role: string }[]).find((candidate) => candidate.id === memberId);

        expect(row?.role).toBe("owner");
    });

    it("allows updateMemberRole demoting an owner when another owner remains", async () => {
        expect.assertions(2);

        const { orgAdmin, orgDatabase } = createOrgFixture();
        const first = await orgAdmin.createUser({ email: "first-owner@example.com", name: "FirstOwner" });
        const second = await orgAdmin.createUser({ email: "second-owner@example.com", name: "SecondOwner" });
        const org = await orgAdmin.createOrganization({ name: "Two Owner Co", ownerId: first.id });

        await orgAdmin.addMember({ organizationId: org.id, role: "owner", userId: second.id });

        const memberId = memberIdOf(orgDatabase, first.id, org.id);

        await orgAdmin.updateMemberRole({ memberId, role: "member" });

        const row = (orgDatabase["member"] as { id: string; role: string }[]).find((candidate) => candidate.id === memberId);

        expect(row?.role).toBe("member");
        expect(orgDatabase["member"]).toHaveLength(2);
    });

    it("does not count a custom role containing 'owner' as an owner", async () => {
        expect.assertions(3);

        const { orgAdmin, orgDatabase } = createOrgFixture();
        const owner = await orgAdmin.createUser({ email: "real-owner@example.com", name: "RealOwner" });
        const helper = await orgAdmin.createUser({ email: "owner-helper@example.com", name: "OwnerHelper" });
        const org = await orgAdmin.createOrganization({ name: "Lookalike Co", ownerId: owner.id });

        await orgAdmin.addMember({ organizationId: org.id, role: "nonowner", userId: helper.id });

        const memberId = memberIdOf(orgDatabase, owner.id, org.id);

        await expect(orgAdmin.removeMember({ memberId })).rejects.toThrow(/LAST_ORGANIZATION_OWNER|last owner/iu);
        await expect(orgAdmin.updateMemberRole({ memberId, role: "member" })).rejects.toThrow(/LAST_ORGANIZATION_OWNER|last owner/iu);
        expect(orgDatabase["member"]).toHaveLength(2);
    });

    it("allows removeMember of an owner when another owner remains", async () => {
        expect.assertions(2);

        const { orgAdmin, orgDatabase } = createOrgFixture();
        const first = await orgAdmin.createUser({ email: "leaving-owner@example.com", name: "Leaving" });
        const second = await orgAdmin.createUser({ email: "staying-owner@example.com", name: "Staying" });
        const org = await orgAdmin.createOrganization({ name: "Leaving Owner Co", ownerId: first.id });

        await orgAdmin.addMember({ organizationId: org.id, role: "owner", userId: second.id });

        await expect(orgAdmin.removeMember({ memberId: memberIdOf(orgDatabase, first.id, org.id) })).resolves.toBeUndefined();

        expect(orgDatabase["member"]).toHaveLength(1);
    });

    it("guards per organization: a sole-owner role elsewhere does not block removal from a co-owned org", async () => {
        expect.assertions(3);

        const { orgAdmin, orgDatabase } = createOrgFixture();
        const user = await orgAdmin.createUser({ email: "two-orgs@example.com", name: "TwoOrgs" });
        const coOwner = await orgAdmin.createUser({ email: "co-owner@example.com", name: "CoOwner" });
        const orgA = await orgAdmin.createOrganization({ name: "Co Owned A", ownerId: user.id });
        const orgB = await orgAdmin.createOrganization({ name: "Sole Owned B", ownerId: user.id });

        await orgAdmin.addMember({ organizationId: orgA.id, role: "owner", userId: coOwner.id });

        // The user is the sole owner of org B; removing them from org A must still succeed.
        await expect(orgAdmin.removeMember({ memberId: memberIdOf(orgDatabase, user.id, orgA.id) })).resolves.toBeUndefined();

        const remainingOrgIds = (orgDatabase["member"] as { organizationId: string; userId: string }[])
            .filter((row) => row.userId === user.id)
            .map((row) => row.organizationId);

        expect(remainingOrgIds).toEqual([orgB.id]);
        expect(orgDatabase["member"]).toHaveLength(2);
    });

    it("removeMember deletes the user's teamMember rows for the organization's teams only", async () => {
        expect.assertions(4);

        const orgDatabase: Record<string, unknown[]> = {
            ...seedMemoryDatabase(),
            invitation: [],
            member: [],
            organization: [],
            team: [],
            teamMember: [],
        };
        const teamAuth = createAuth({
            baseURL: "http://localhost",
            database: memoryAdapter(orgDatabase),
            emailAndPassword: { enabled: true },
            plugins: [admin(), organization({ teams: { defaultTeam: { enabled: false }, enabled: true } })],
            secret: SECRET,
        });
        const teamAdmin = createAuthAdmin(teamAuth);

        const owner = await teamAdmin.createUser({ email: "team-owner@example.com", name: "TeamOwner" });
        const leaver = await teamAdmin.createUser({ email: "team-leaver@example.com", name: "TeamLeaver" });
        const stayer = await teamAdmin.createUser({ email: "team-stayer@example.com", name: "TeamStayer" });
        const orgA = await teamAdmin.createOrganization({ name: "Team Org A", ownerId: owner.id });
        const orgB = await teamAdmin.createOrganization({ name: "Team Org B", ownerId: owner.id });
        await teamAdmin.addMember({ organizationId: orgA.id, userId: leaver.id });
        await teamAdmin.addMember({ organizationId: orgA.id, userId: stayer.id });

        const teamA = await teamAdmin.createTeam({ name: "Team A", organizationId: orgA.id });
        const teamB = await teamAdmin.createTeam({ name: "Team B", organizationId: orgB.id });

        await teamAdmin.addTeamMember({ teamId: teamA.id, userId: leaver.id });
        const stayerRow = await teamAdmin.addTeamMember({ teamId: teamA.id, userId: stayer.id });
        const otherOrgRow = await teamAdmin.addTeamMember({ teamId: teamB.id, userId: leaver.id });

        await teamAdmin.removeMember({ memberId: memberIdOf(orgDatabase, leaver.id, orgA.id) });

        const remaining = orgDatabase["teamMember"] as { id: string; teamId: string; userId: string }[];

        expect(remaining.some((row) => row.teamId === teamA.id && row.userId === leaver.id)).toBe(false);
        expect(remaining.map((row) => row.id)).toContain(stayerRow.id);
        expect(remaining.map((row) => row.id)).toContain(otherOrgRow.id);
        expect(remaining).toHaveLength(2);
    });

    it("removeMember keeps the member row when team cleanup fails, so a retry can finish it", async () => {
        expect.assertions(3);

        const orgDatabase: Record<string, unknown[]> = {
            ...seedMemoryDatabase(),
            invitation: [],
            member: [],
            organization: [],
            team: [],
            teamMember: [],
        };
        const teamAuth = createAuth({
            baseURL: "http://localhost",
            database: memoryAdapter(orgDatabase),
            emailAndPassword: { enabled: true },
            plugins: [admin(), organization({ teams: { defaultTeam: { enabled: false }, enabled: true } })],
            secret: SECRET,
        });
        const teamAdmin = createAuthAdmin(teamAuth);

        const owner = await teamAdmin.createUser({ email: "retry-owner@example.com", name: "RetryOwner" });
        const leaver = await teamAdmin.createUser({ email: "retry-leaver@example.com", name: "RetryLeaver" });
        const org = await teamAdmin.createOrganization({ name: "Retry Org", ownerId: owner.id });

        await teamAdmin.addMember({ organizationId: org.id, userId: leaver.id });

        const team = await teamAdmin.createTeam({ name: "Retry Team", organizationId: org.id });

        await teamAdmin.addTeamMember({ teamId: team.id, userId: leaver.id });

        const memberId = memberIdOf(orgDatabase, leaver.id, org.id);
        const { adapter } = await teamAuth.$context;
        const deleteMany = adapter.deleteMany.bind(adapter);

        adapter.deleteMany = async () => {
            throw new Error("injected teamMember failure");
        };

        await expect(teamAdmin.removeMember({ memberId })).rejects.toThrow(/injected teamMember failure/u);
        expect((orgDatabase["member"] as { id: string }[]).some((row) => row.id === memberId)).toBe(true);

        adapter.deleteMany = deleteMany;
        await teamAdmin.removeMember({ memberId });

        expect((orgDatabase["teamMember"] as { userId: string }[]).some((row) => row.userId === leaver.id)).toBe(false);
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
        expect.assertions(4);

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

        // The returned number is worthless if the row the token points at expires at a different
        // time (or carries no expiry at all) — that is what actually ends the impersonation.
        const rows = sessionRows(user.id);

        expect(rows).toHaveLength(1);
        expect(asMillis(rows[0]?.["expiresAt"])).toBe(result.expiresAt);
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

    it("unlinkAccount scopes the delete to the owning user (no cross-user IDOR)", async () => {
        expect.assertions(3);

        // Two users, each with their own credential account row.
        const victim = await adminApi.createUser({ email: "victim@example.com", name: "Victim", password: STRONG_PASSWORD });
        await adminApi.createUser({ email: "attacker@example.com", name: "Attacker", password: STRONG_PASSWORD });

        const victimAccounts = await adminApi.listAccounts({ userId: victim.id });

        expect(victimAccounts).toHaveLength(1);

        const victimAccountId = victimAccounts[0]!.id;

        // Pass the victim's accountId but a *different* (wrong) userId. The
        // ownership scoping in the where-clause must prevent the delete from
        // landing — the victim's account row stays intact.
        await adminApi.unlinkAccount({ accountId: victimAccountId, userId: "someone-else" });

        const stillThere = await adminApi.listAccounts({ userId: victim.id });

        expect(stillThere).toHaveLength(1);
        expect(stillThere[0]?.id).toBe(victimAccountId);
    });
});
