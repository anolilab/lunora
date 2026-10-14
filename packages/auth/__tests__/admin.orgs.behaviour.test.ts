import { memoryAdapter } from "better-auth/adapters/memory";
import { beforeEach, describe, expect, it } from "vitest";

import { createAuthAdmin } from "../src/admin";
import { createAuth } from "../src/create-auth";
import { organization } from "../src/plugins";

/**
 * Round-trip behaviour for the organization/team surface of `createAuthAdmin`
 * (`packages/auth/src/admin.ts`), exercised against the real better-auth
 * runtime on an in-memory adapter (no mocks). This is a sibling to
 * `admin.behaviour.test.ts` — split out because the org/team method group is
 * large enough on its own to blow past that file's line budget — and mirrors
 * its conventions (`expect.assertions(n)`, no mocked adapter, no `.js`
 * extensions).
 *
 * These methods back the Studio's org-management UI through admin-token-gated
 * runtime routes and talk to better-auth's raw `adapter` directly (bypassing
 * the organization plugin's own session-gated endpoints — see the "Trust
 * model" note on `createAuthAdmin`), so there is no session/cookie dance here:
 * every call is made directly against `adminApi`, the same way the runtime
 * calls it.
 */

const SECRET = "x".repeat(32);

/** Create a user via the admin API and return just its id — most org tests need a userId, not the full row. */
const createUserRow = async (adminApi: ReturnType<typeof createAuthAdmin>, email: string, name: string): Promise<string> => {
    const user = await adminApi.createUser({ email, name });

    return user.id;
};

describe("createAuthAdmin — organizations", () => {
    let database: Record<string, unknown[]>;
    // `any` to reach plugin-contributed shapes without re-deriving the generic chain.
    let auth: any;
    let adminApi: ReturnType<typeof createAuthAdmin>;

    beforeEach(() => {
        database = {
            account: [],
            invitation: [],
            member: [],
            organization: [],
            session: [],
            user: [],
            verification: [],
        };
        auth = createAuth({
            baseURL: "http://localhost",
            database: memoryAdapter(database),
            emailAndPassword: { enabled: true },
            plugins: [organization()],
            secret: SECRET,
        });
        adminApi = createAuthAdmin(auth);
    });

    it("createOrganization creates the org row and seeds an owner member (Step 1 smoke test)", async () => {
        expect.assertions(5);

        const ownerId = await createUserRow(adminApi, "owner@example.com", "Owner");

        const org = await adminApi.createOrganization({ name: "Acme Inc", ownerId });

        expect(org.name).toBe("Acme Inc");
        expect(org.slug).toBe("acme-inc");
        expect(database["organization"]).toHaveLength(1);

        const members = database["member"] as { organizationId: string; role: string; userId: string }[];

        expect(members).toHaveLength(1);
        expect(members[0]).toMatchObject({ organizationId: org.id, role: "owner", userId: ownerId });
    });

    it("createOrganization without an ownerId seeds no member row", async () => {
        expect.assertions(2);

        const org = await adminApi.createOrganization({ name: "No Owner Co" });

        expect(org.id).toBeDefined();
        expect(database["member"]).toHaveLength(0);
    });

    it("addMember adds a user to an org with the given role", async () => {
        expect.assertions(3);

        const ownerId = await createUserRow(adminApi, "owner2@example.com", "Owner2");
        const org = await adminApi.createOrganization({ name: "Beta", ownerId });
        const memberUserId = await createUserRow(adminApi, "member@example.com", "Member");

        const member = await adminApi.addMember({ organizationId: org.id, role: "admin", userId: memberUserId });

        expect(member.role).toBe("admin");
        expect(member.organizationId).toBe(org.id);
        expect(database["member"]).toHaveLength(2); // the seeded owner + this member
    });

    it('addMember defaults the role to "member" when omitted', async () => {
        expect.assertions(1);

        const org = await adminApi.createOrganization({ name: "Gamma" });
        const userId = await createUserRow(adminApi, "gamma-member@example.com", "GammaMember");

        const member = await adminApi.addMember({ organizationId: org.id, userId });

        expect(member.role).toBe("member");
    });

    // NOTE (see plan 123 NOTES): the memory adapter has no FK enforcement, so
    // addMember against a nonexistent organizationId silently creates an
    // orphaned member row rather than throwing. This test pins that *observed*
    // behavior; it is not asserting the API should behave this way.
    it("addMember against a nonexistent organization id creates an orphan member row", async () => {
        expect.assertions(2);

        const userId = await createUserRow(adminApi, "orphan@example.com", "Orphan");

        const member = await adminApi.addMember({ organizationId: "does-not-exist", userId });

        expect(member.organizationId).toBe("does-not-exist");
        expect((database["member"] as { id: string }[]).some((row) => row.id === member.id)).toBe(true);
    });

    it("updateMemberRole updates exactly the addressed member and leaves others untouched", async () => {
        expect.assertions(4);

        const org = await adminApi.createOrganization({ name: "Delta" });
        const userA = await createUserRow(adminApi, "a@example.com", "A");
        const userB = await createUserRow(adminApi, "b@example.com", "B");
        const memberA = await adminApi.addMember({ organizationId: org.id, role: "member", userId: userA });
        const memberB = await adminApi.addMember({ organizationId: org.id, role: "member", userId: userB });

        const updated = await adminApi.updateMemberRole({ memberId: memberA.id, role: "admin" });

        expect(updated.role).toBe("admin");

        const rows = database["member"] as { id: string; role: string; userId: string }[];
        const rowA = rows.find((row) => row.id === memberA.id);
        const rowB = rows.find((row) => row.id === memberB.id);

        expect(rowA?.role).toBe("admin");
        expect(rowB?.role).toBe("member");
        expect(rowB).toMatchObject({ id: memberB.id, role: "member", userId: userB });
    });

    it("updateMemberRole serializes an array role to a comma-joined string", async () => {
        expect.assertions(1);

        const org = await adminApi.createOrganization({ name: "Epsilon" });
        const userId = await createUserRow(adminApi, "multi@example.com", "Multi");
        const member = await adminApi.addMember({ organizationId: org.id, userId });

        const updated = await adminApi.updateMemberRole({ memberId: member.id, role: ["admin", "billing"] });

        expect(updated.role).toBe("admin,billing");
    });

    it("removeMember deletes exactly the addressed row (other members across orgs survive)", async () => {
        expect.assertions(4);

        const orgOne = await adminApi.createOrganization({ name: "Org One" });
        const orgTwo = await adminApi.createOrganization({ name: "Org Two" });

        const userOneA = await createUserRow(adminApi, "one-a@example.com", "OneA");
        const userOneB = await createUserRow(adminApi, "one-b@example.com", "OneB");
        const userTwoA = await createUserRow(adminApi, "two-a@example.com", "TwoA");
        const userTwoB = await createUserRow(adminApi, "two-b@example.com", "TwoB");

        const memberOneA = await adminApi.addMember({ organizationId: orgOne.id, userId: userOneA });
        const memberOneB = await adminApi.addMember({ organizationId: orgOne.id, userId: userOneB });
        const memberTwoA = await adminApi.addMember({ organizationId: orgTwo.id, userId: userTwoA });
        const memberTwoB = await adminApi.addMember({ organizationId: orgTwo.id, userId: userTwoB });

        await adminApi.removeMember({ memberId: memberOneA.id });

        const remainingIds = (database["member"] as { id: string }[]).map((row) => row.id);

        expect(remainingIds).not.toContain(memberOneA.id);
        expect(remainingIds).toContain(memberOneB.id);
        expect(remainingIds).toContain(memberTwoA.id);
        expect(remainingIds).toContain(memberTwoB.id);
    });

    it("inviteMember resolves the inviter to the org owner when omitted", async () => {
        expect.assertions(4);

        const ownerId = await createUserRow(adminApi, "owner3@example.com", "Owner3");
        const org = await adminApi.createOrganization({ name: "Zeta", ownerId });

        const invitation = await adminApi.inviteMember({ email: "Invitee@Example.com", organizationId: org.id });

        expect(invitation.email).toBe("invitee@example.com");
        expect(invitation.organizationId).toBe(org.id);
        expect(invitation.role).toBe("member");
        expect((invitation as unknown as { inviterId: string })["inviterId"]).toBe(ownerId);
    });

    it("inviteMember rejects when the org has no members to attribute the invite to", async () => {
        expect.assertions(1);

        const org = await adminApi.createOrganization({ name: "NoMembers" });

        await expect(adminApi.inviteMember({ email: "nobody@example.com", organizationId: org.id })).rejects.toThrow(/inviter/iu);
    });

    it("cancelInvitation removes exactly the addressed invitation", async () => {
        expect.assertions(2);

        const ownerId = await createUserRow(adminApi, "owner4@example.com", "Owner4");
        const org = await adminApi.createOrganization({ name: "Theta", ownerId });

        const invitationOne = await adminApi.inviteMember({ email: "one@example.com", organizationId: org.id });
        const invitationTwo = await adminApi.inviteMember({ email: "two@example.com", organizationId: org.id });

        await adminApi.cancelInvitation({ invitationId: invitationOne.id });

        const remainingIds = (database["invitation"] as { id: string }[]).map((row) => row.id);

        expect(remainingIds).not.toContain(invitationOne.id);
        expect(remainingIds).toContain(invitationTwo.id);
    });

    it("deleteOrganization cascades members + invitations and leaves an unrelated org intact", async () => {
        expect.assertions(6);

        const ownerId = await createUserRow(adminApi, "owner5@example.com", "Owner5");
        const orgToDelete = await adminApi.createOrganization({ name: "ToDelete", ownerId });
        const otherOwnerId = await createUserRow(adminApi, "owner6@example.com", "Owner6");
        const otherOrg = await adminApi.createOrganization({ name: "Survivor", ownerId: otherOwnerId });

        const memberUserId = await createUserRow(adminApi, "extra-member@example.com", "ExtraMember");

        await adminApi.addMember({ organizationId: orgToDelete.id, userId: memberUserId });
        await adminApi.inviteMember({ email: "invitee2@example.com", organizationId: orgToDelete.id });

        const otherMemberUserId = await createUserRow(adminApi, "other-member@example.com", "OtherMember");

        await adminApi.addMember({ organizationId: otherOrg.id, userId: otherMemberUserId });
        await adminApi.inviteMember({ email: "invitee3@example.com", organizationId: otherOrg.id });

        await adminApi.deleteOrganization({ organizationId: orgToDelete.id });

        const orgs = database["organization"] as { id: string }[];
        const members = database["member"] as { organizationId: string }[];
        const invitations = database["invitation"] as { organizationId: string }[];

        expect(orgs.some((row) => row.id === orgToDelete.id)).toBe(false);
        expect(orgs.some((row) => row.id === otherOrg.id)).toBe(true);
        expect(members.some((row) => row.organizationId === orgToDelete.id)).toBe(false);
        expect(invitations.some((row) => row.organizationId === orgToDelete.id)).toBe(false);
        expect(members.some((row) => row.organizationId === otherOrg.id)).toBe(true);
        expect(invitations.some((row) => row.organizationId === otherOrg.id)).toBe(true);
    });

    it("updateOrganization updates the addressed row and synthesizes a row when nothing matches", async () => {
        expect.assertions(3);

        const org = await adminApi.createOrganization({ name: "Old Name", slug: "old-slug" });

        const updated = await adminApi.updateOrganization({ name: "New Name", organizationId: org.id });

        expect(updated.name).toBe("New Name");
        expect((database["organization"] as { id: string; name: string }[]).find((row) => row.id === org.id)?.name).toBe("New Name");

        // The memory adapter's `update` returns `null` when the where-clause
        // matches no row (a nonexistent organizationId). `createAuthAdmin`
        // treats a `null` result as "adapter didn't echo the row" rather than
        // not-found and synthesizes a minimal success row instead of throwing.
        const synthesized = await adminApi.updateOrganization({ name: "Ghost", organizationId: "nonexistent-org-id" });

        expect(synthesized.id).toBe("nonexistent-org-id");
    });

    it("listOrganizations / listMembers / listInvitations return what was seeded, respecting limit", async () => {
        expect.assertions(6);

        const ownerId = await createUserRow(adminApi, "owner7@example.com", "Owner7");
        const orgA = await adminApi.createOrganization({ name: "Org A", ownerId });

        await adminApi.createOrganization({ name: "Org B" });

        const memberUserId = await createUserRow(adminApi, "member7@example.com", "Member7");

        await adminApi.addMember({ organizationId: orgA.id, userId: memberUserId });
        await adminApi.inviteMember({ email: "invite7a@example.com", organizationId: orgA.id });
        await adminApi.inviteMember({ email: "invite7b@example.com", organizationId: orgA.id });

        const allOrgs = await adminApi.listOrganizations({});

        expect(allOrgs.total).toBe(2);

        const limitedOrgs = await adminApi.listOrganizations({ limit: 1 });

        expect(limitedOrgs.rows).toHaveLength(1);

        const members = await adminApi.listMembers({ organizationId: orgA.id });

        expect(members.total).toBe(2); // the seeded owner + memberUserId
        expect(members.rows.map((row) => row.userId).toSorted((a, b) => a.localeCompare(b))).toEqual(
            [memberUserId, ownerId].toSorted((a, b) => a.localeCompare(b)),
        );

        const invitations = await adminApi.listInvitations({ organizationId: orgA.id });

        expect(invitations.total).toBe(2);

        const limitedInvitations = await adminApi.listInvitations({ limit: 1, organizationId: orgA.id });

        expect(limitedInvitations.rows).toHaveLength(1);
    });
});

describe("createAuthAdmin — teams & org roles", () => {
    let database: Record<string, unknown[]>;
    // `any` to reach plugin-contributed shapes without re-deriving the generic chain.
    let auth: any;
    let adminApi: ReturnType<typeof createAuthAdmin>;

    // Teams and dynamic access control (custom org roles) aren't enabled by
    // the base `organization()` config used above or in
    // `plugins.behaviour.test.ts` — enable both locally, scoped to this
    // describe only, per plan 123 Step 3.
    beforeEach(() => {
        database = {
            account: [],
            invitation: [],
            member: [],
            organization: [],
            organizationRole: [],
            session: [],
            team: [],
            teamMember: [],
            user: [],
            verification: [],
        };
        auth = createAuth({
            baseURL: "http://localhost",
            database: memoryAdapter(database),
            emailAndPassword: { enabled: true },
            plugins: [
                organization({
                    dynamicAccessControl: { enabled: true },
                    teams: { defaultTeam: { enabled: false }, enabled: true },
                }),
            ],
            secret: SECRET,
        });
        adminApi = createAuthAdmin(auth);
    });

    it("createTeam creates a team row under the organization", async () => {
        expect.assertions(2);

        const org = await adminApi.createOrganization({ name: "Iota" });

        const team = await adminApi.createTeam({ name: "Engineering", organizationId: org.id });

        expect(team.name).toBe("Engineering");
        expect(team.organizationId).toBe(org.id);
    });

    it("addTeamMember adds a user to the team", async () => {
        expect.assertions(2);

        const org = await adminApi.createOrganization({ name: "Kappa" });
        const team = await adminApi.createTeam({ name: "Support", organizationId: org.id });
        const userId = await createUserRow(adminApi, "teammate@example.com", "Teammate");

        const teamMember = await adminApi.addTeamMember({ teamId: team.id, userId });

        expect(teamMember.teamId).toBe(team.id);
        expect(teamMember.userId).toBe(userId);
    });

    it("removeTeamMember deletes exactly the addressed row", async () => {
        expect.assertions(3);

        const org = await adminApi.createOrganization({ name: "Lambda" });
        const team = await adminApi.createTeam({ name: "Ops", organizationId: org.id });
        const userA = await createUserRow(adminApi, "opsA@example.com", "OpsA");
        const userB = await createUserRow(adminApi, "opsB@example.com", "OpsB");

        const teamMemberA = await adminApi.addTeamMember({ teamId: team.id, userId: userA });
        const teamMemberB = await adminApi.addTeamMember({ teamId: team.id, userId: userB });

        await adminApi.removeTeamMember({ teamMemberId: teamMemberA.id });

        const remainingIds = (database["teamMember"] as { id: string }[]).map((row) => row.id);

        expect(remainingIds).not.toContain(teamMemberA.id);
        expect(remainingIds).toContain(teamMemberB.id);
        expect(remainingIds).toHaveLength(1);
    });

    it("removeTeam deletes the team and its memberships", async () => {
        expect.assertions(2);

        const org = await adminApi.createOrganization({ name: "Mu" });
        const teamToDelete = await adminApi.createTeam({ name: "Disbanded", organizationId: org.id });
        const survivingTeam = await adminApi.createTeam({ name: "Surviving", organizationId: org.id });
        const userId = await createUserRow(adminApi, "disbanded@example.com", "Disbanded");

        await adminApi.addTeamMember({ teamId: teamToDelete.id, userId });

        await adminApi.removeTeam({ teamId: teamToDelete.id });

        const teamIds = (database["team"] as { id: string }[]).map((row) => row.id);
        const teamMemberTeamIds = (database["teamMember"] as { teamId: string }[]).map((row) => row.teamId);

        expect(teamIds).toEqual([survivingTeam.id]);
        expect(teamMemberTeamIds).not.toContain(teamToDelete.id);
    });

    it("createOrgRole creates a custom role with a serialized permission map", async () => {
        expect.assertions(3);

        const org = await adminApi.createOrganization({ name: "Nu" });

        const role = await adminApi.createOrgRole({
            organizationId: org.id,
            permission: { billing: ["read", "update"] },
            role: "billing-admin",
        });

        expect(role.role).toBe("billing-admin");
        expect(role.organizationId).toBe(org.id);
        expect(JSON.parse(role.permission as string)).toEqual({ billing: ["read", "update"] });
    });

    it("updateOrgRole replaces the permission grant for exactly the addressed role", async () => {
        expect.assertions(2);

        const org = await adminApi.createOrganization({ name: "Xi" });
        const roleA = await adminApi.createOrgRole({ organizationId: org.id, permission: { billing: ["read"] }, role: "role-a" });
        const roleB = await adminApi.createOrgRole({ organizationId: org.id, permission: { billing: ["read"] }, role: "role-b" });

        await adminApi.updateOrgRole({ permission: { billing: ["read", "update", "delete"] }, roleId: roleA.id });

        const rows = database["organizationRole"] as { id: string; permission: string }[];
        const rowA = rows.find((row) => row.id === roleA.id);
        const rowB = rows.find((row) => row.id === roleB.id);

        expect(JSON.parse(rowA?.permission ?? "{}")).toEqual({ billing: ["read", "update", "delete"] });
        expect(JSON.parse(rowB?.permission ?? "{}")).toEqual({ billing: ["read"] });
    });

    it("deleteOrgRole removes exactly the addressed role", async () => {
        expect.assertions(2);

        const org = await adminApi.createOrganization({ name: "Omicron" });
        const roleA = await adminApi.createOrgRole({ organizationId: org.id, permission: { billing: ["read"] }, role: "role-a" });
        const roleB = await adminApi.createOrgRole({ organizationId: org.id, permission: { billing: ["read"] }, role: "role-b" });

        await adminApi.deleteOrgRole({ roleId: roleA.id });

        const remainingIds = (database["organizationRole"] as { id: string }[]).map((row) => row.id);

        expect(remainingIds).not.toContain(roleA.id);
        expect(remainingIds).toContain(roleB.id);
    });

    it("updateTeam renames exactly the addressed team", async () => {
        expect.assertions(2);

        const org = await adminApi.createOrganization({ name: "Rho" });
        const teamA = await adminApi.createTeam({ name: "Old Name", organizationId: org.id });
        const teamB = await adminApi.createTeam({ name: "Untouched", organizationId: org.id });

        const updated = await adminApi.updateTeam({ name: "New Name", teamId: teamA.id });

        expect(updated.name).toBe("New Name");

        const rowB = (database["team"] as { id: string; name: string }[]).find((row) => row.id === teamB.id);

        expect(rowB?.name).toBe("Untouched");
    });

    it("listTeams / listTeamMembers / listOrgRoles return what was seeded", async () => {
        expect.assertions(3);

        const org = await adminApi.createOrganization({ name: "Pi" });

        await adminApi.createTeam({ name: "Team One", organizationId: org.id });

        const teamTwo = await adminApi.createTeam({ name: "Team Two", organizationId: org.id });
        const userId = await createUserRow(adminApi, "pi-member@example.com", "PiMember");

        await adminApi.addTeamMember({ teamId: teamTwo.id, userId });
        await adminApi.createOrgRole({ organizationId: org.id, permission: { billing: ["read"] }, role: "reader" });

        const teams = await adminApi.listTeams({ organizationId: org.id });
        const teamMembers = await adminApi.listTeamMembers({ teamId: teamTwo.id });
        const orgRoles = await adminApi.listOrgRoles({ organizationId: org.id });

        expect(teams.total).toBe(2);
        expect(teamMembers.total).toBe(1);
        expect(orgRoles.total).toBe(1);
    });

    it("deleteOrganization cascades teams, team members, and org roles when teams are enabled", async () => {
        expect.assertions(3);

        const org = await adminApi.createOrganization({ name: "Sigma" });
        const team = await adminApi.createTeam({ name: "Doomed Team", organizationId: org.id });
        const userId = await createUserRow(adminApi, "doomed@example.com", "Doomed");

        await adminApi.addTeamMember({ teamId: team.id, userId });

        const role = await adminApi.createOrgRole({ organizationId: org.id, permission: { billing: ["read"] }, role: "doomed-role" });

        await adminApi.deleteOrganization({ organizationId: org.id });

        expect((database["team"] as { organizationId: string }[]).some((row) => row.organizationId === org.id)).toBe(false);
        expect((database["teamMember"] as { teamId: string }[]).some((row) => row.teamId === team.id)).toBe(false);
        expect((database["organizationRole"] as { id: string }[]).some((row) => row.id === role.id)).toBe(false);
    });
});
