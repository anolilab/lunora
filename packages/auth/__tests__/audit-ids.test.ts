import { describe, expect, it } from "vitest";

import { buildAuditEntry } from "../src/audit-hooks";

/**
 * Which organization, role, member and resource an audit row names. Each case is a request shape that once
 * named the wrong thing or nothing at all.
 */
describe("audit rows name the organization, role, member and resource they act on", () => {
    const activeInA = { session: { activeOrganizationId: "org_a" } };

    it("does not attribute an invitation to the active organization when the request names none", () => {
        expect.assertions(2);

        const accept = buildAuditEntry({
            body: { invitationId: "inv_1" },
            context: { session: activeInA },
            path: "/api/auth/organization/accept-invitation",
        });

        expect(accept?.detail).not.toHaveProperty("organizationId");
        expect(accept?.detail).toMatchObject({ invitationId: "inv_1" });
    });

    it("names the organization a switch moves to, and none when the switch clears it", () => {
        expect.assertions(2);

        const cleared = buildAuditEntry({
            body: { organizationId: null },
            context: { session: activeInA },
            path: "/api/auth/organization/set-active",
        });
        const moved = buildAuditEntry({
            body: { organizationId: "org_b" },
            context: { session: activeInA },
            path: "/api/auth/organization/set-active",
        });

        expect(cleared?.detail).not.toHaveProperty("organizationId");
        expect(moved?.detail).toMatchObject({ organizationId: "org_b" });
    });

    it("never copies an email, even when the `@` falls past the detail length limit", () => {
        expect.assertions(1);

        const longEmail = `${"a".repeat(300)}@example.com`;
        const entry = buildAuditEntry({ body: { memberIdOrEmail: longEmail }, path: "/api/auth/organization/remove-member" });

        expect(entry?.detail).not.toHaveProperty("memberId");
    });

    it("names the role a role change acts on", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({ body: { roleId: "role_9" }, path: "/api/auth/organization/update-role" });

        expect(entry?.detail).toMatchObject({ roleId: "role_9" });
    });

    it("names the SCIM user and group a provisioning create made, from its response", () => {
        expect.assertions(2);

        const user = buildAuditEntry({
            body: { userName: "ada" },
            context: { returned: { id: "scim_user_1", userName: "ada" } },
            method: "POST",
            path: "/api/auth/scim/v2/Users",
        });
        const group = buildAuditEntry({
            body: { displayName: "Eng" },
            context: { returned: { id: "scim_group_1", displayName: "Eng" } },
            method: "POST",
            path: "/api/auth/scim/v2/Groups",
        });

        expect(user?.detail).toMatchObject({ scimUserId: "scim_user_1" });
        expect(group?.detail).toMatchObject({ scimGroupId: "scim_group_1" });
    });

    it("names the OAuth resource a create made, from the identifier it was sent", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({ body: { identifier: "https://api.example.com" }, method: "POST", path: "/api/auth/admin/oauth2/resources" });

        expect(entry?.detail).toMatchObject({ resourceIdentifier: "https://api.example.com" });
    });

    it("names the role a create was sent under, from the name it carries as role", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({ body: { role: "admin" }, method: "POST", path: "/api/auth/organization/create-role" });

        expect(entry?.detail).toMatchObject({ roleName: "admin" });
    });

    it("records the role a member is changed to", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({
            body: { memberId: "m_1", role: "admin" },
            method: "POST",
            path: "/api/auth/organization/update-member-role",
        });

        expect(entry?.detail).toMatchObject({ memberId: "m_1", role: "admin" });
    });

    it("records every role a member is set to when the change assigns several", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({
            body: { memberId: "m_2", role: ["admin", "member"] },
            method: "POST",
            path: "/api/auth/organization/update-member-role",
        });

        expect(entry?.detail).toMatchObject({ role: "admin,member" });
    });

    it("names the active organization a team change happens in, not one a body asserts", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({
            body: { teamId: "team_1", organizationId: "org_forged" },
            context: { session: { session: { activeOrganizationId: "org_a" } } },
            method: "POST",
            path: "/api/auth/organization/update-team",
        });

        expect(entry?.detail).toMatchObject({ organizationId: "org_a", teamId: "team_1" });
    });

    it("names the organization a team is created in or removed from when the request names one, not the active organization", () => {
        expect.assertions(2);

        const session = { session: { activeOrganizationId: "org_a" } };
        const created = buildAuditEntry({
            body: { name: "Crew", organizationId: "org_b" },
            context: { session },
            method: "POST",
            path: "/api/auth/organization/create-team",
        });
        const removed = buildAuditEntry({
            body: { organizationId: "org_b", teamId: "team_1" },
            context: { session },
            method: "POST",
            path: "/api/auth/organization/remove-team",
        });

        expect(created?.detail).toMatchObject({ organizationId: "org_b" });
        expect(removed?.detail).toMatchObject({ organizationId: "org_b", teamId: "team_1" });
    });

    it("names the active organization for a team removal that names none", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({
            body: { teamId: "team_1" },
            context: { session: { session: { activeOrganizationId: "org_a" } } },
            method: "POST",
            path: "/api/auth/organization/remove-team",
        });

        expect(entry?.detail).toMatchObject({ organizationId: "org_a" });
    });

    it("names no organization for a team change with no active organization, whatever the body asserts", () => {
        expect.assertions(2);

        const entry = buildAuditEntry({
            body: { teamId: "team_1", organizationId: "org_forged" },
            method: "POST",
            path: "/api/auth/organization/update-team",
        });

        expect(entry?.detail).toMatchObject({ teamId: "team_1" });
        expect(entry?.detail).not.toHaveProperty("organizationId");
    });

    it("names the organization a team update selects in its data, not the active organization", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({
            body: { data: { name: "Crew", organizationId: "org_b" }, teamId: "team_1" },
            context: { session: { session: { activeOrganizationId: "org_a" } } },
            method: "POST",
            path: "/api/auth/organization/update-team",
        });

        expect(entry?.detail).toMatchObject({ organizationId: "org_b", teamId: "team_1" });
    });

    it.each(["add-team-member", "remove-team-member"])("names the organization %s selects, not the active organization", (endpoint) => {
        expect.assertions(1);

        const entry = buildAuditEntry({
            body: { organizationId: "org_b", teamId: "team_1", userId: "member_c" },
            context: { session: { session: { activeOrganizationId: "org_a" } } },
            method: "POST",
            path: `/api/auth/organization/${endpoint}`,
        });

        expect(entry?.detail).toMatchObject({ organizationId: "org_b", targetUserId: "member_c" });
    });

    it("names only the active organization for a team switch", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({
            body: { organizationId: "org_b", teamId: "team_1" },
            context: { session: { session: { activeOrganizationId: "org_a" } } },
            method: "POST",
            path: "/api/auth/organization/set-active-team",
        });

        expect(entry?.detail).toMatchObject({ organizationId: "org_a" });
    });
});
