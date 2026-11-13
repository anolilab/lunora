import { describe, expect, it } from "vitest";

import { buildAuditEntry } from "../src/audit-hooks";

/** What a request names is not trusted over what the response or the session says. */
describe("audit rows trust the response and the session over a stray body field", () => {
    it("does not name a client from a registration that failed", () => {
        expect.assertions(1);

        const failed = Object.assign(new Error("invalid registration"), { client_id: "app_never", status: 400 });
        const entry = buildAuditEntry({
            body: { client_name: "Portal" },
            context: { returned: failed },
            method: "POST",
            path: "/api/auth/oauth2/register",
        });

        expect(entry?.detail).not.toHaveProperty("clientId");
    });

    it("names the organization an invitation belongs to, not the one a request asserts", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({
            body: { invitationId: "inv_1", organizationId: "org_forged" },
            context: { returned: { invitation: { id: "inv_1", organizationId: "org_real" } } },
            method: "POST",
            path: "/api/auth/organization/accept-invitation",
        });

        expect(entry?.detail).toMatchObject({ organizationId: "org_real" });
    });

    it("names the impersonated account even when the body names another user", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({
            body: { memberId: "m_1", userId: "stray_user" },
            context: {
                session: { session: { impersonatedBy: "admin_a", userId: "user_b" }, user: { id: "user_b" } },
            },
            method: "POST",
            path: "/api/auth/organization/remove-member",
        });

        expect(entry?.detail).toMatchObject({ targetUserId: "user_b" });
    });

    it("names the member a team change acts on, even in an impersonated session", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({
            body: { teamId: "team_1", userId: "member_c" },
            context: {
                session: { session: { impersonatedBy: "admin_a", userId: "user_b" }, user: { id: "user_b" } },
            },
            method: "POST",
            path: "/api/auth/organization/add-team-member",
        });

        expect(entry?.detail).toMatchObject({ targetUserId: "member_c" });
    });

    it("names the organization a new team is made in from the request", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({
            body: { name: "Platform", organizationId: "org_b" },
            context: { session: { session: { activeOrganizationId: "org_a" } } },
            method: "POST",
            path: "/api/auth/organization/create-team",
        });

        expect(entry?.detail).toMatchObject({ organizationId: "org_b" });
    });

    it("does not take a cancelled invitation's organization from the request", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({
            body: { invitationId: "inv_2", organizationId: "org_forged" },
            context: { returned: { status: true } },
            method: "POST",
            path: "/api/auth/organization/cancel-invitation",
        });

        expect(entry?.detail).not.toHaveProperty("organizationId");
    });
});
