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
});
