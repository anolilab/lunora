import { describe, expect, it } from "vitest";

import { buildAuditEntry } from "../src/audit-hooks";

/**
 * The organization, consent and refresh rows name what they act on. Each case is one request or response
 * shape, and the row has to say which organization, client or member it was about.
 */
describe("audit rows name the organization, client and member they act on", () => {
    it("records a team switch as its own event, and dynamic role changes as role changes", () => {
        expect.assertions(4);

        expect(buildAuditEntry({ body: { teamId: "t_1" }, path: "/api/auth/organization/set-active-team" })?.event).toBe("org-team-switch");
        expect(buildAuditEntry({ body: { organizationId: "o_1" }, path: "/api/auth/organization/set-active" })?.event).toBe("org-switch");
        expect(buildAuditEntry({ body: { role: "admin" }, path: "/api/auth/organization/create-role" })?.event).toBe("org-role-change");
        expect(buildAuditEntry({ body: { roleName: "editor" }, path: "/api/auth/organization/delete-role" })?.event).toBe("org-role-change");
    });

    it("names the organization a new one was created as, from its response", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({
            body: { name: "Acme", slug: "acme" },
            context: { returned: { id: "o_new", name: "Acme" } },
            path: "/api/auth/organization/create",
        });

        expect(entry?.detail).toMatchObject({ organizationId: "o_new" });
    });

    it("falls back to the session's active organization when a member change does not name one", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({
            body: { role: "member" },
            context: { session: { session: { activeOrganizationId: "o_active" } } },
            path: "/api/auth/organization/update-member-role",
        });

        expect(entry?.detail).toMatchObject({ organizationId: "o_active" });
    });

    it("names the member a removal targets, whether the caller gave an id or an email", () => {
        expect.assertions(3);

        const byId = buildAuditEntry({ body: { memberId: "m_1" }, path: "/api/auth/organization/remove-member" });
        const byEmail = buildAuditEntry({ body: { memberIdOrEmail: "ada@example.com" }, path: "/api/auth/organization/remove-member" });
        const byIdOrEmail = buildAuditEntry({ body: { memberIdOrEmail: "m_2" }, path: "/api/auth/organization/remove-member" });

        expect(byId?.detail).toMatchObject({ memberId: "m_1" });
        expect(byEmail?.detail).not.toHaveProperty("memberId");
        expect(byIdOrEmail?.detail).toMatchObject({ memberId: "m_2" });
    });

    it("refused consent is a failure, and the consent row names the client from the OAuth query", () => {
        expect.assertions(3);

        const refused = buildAuditEntry({
            body: { accept: false, oauth_query: "client_id=app_1&scope=openid" },
            path: "/api/auth/oauth2/consent",
        });
        const granted = buildAuditEntry({
            body: { accept: true, oauth_query: "client_id=app_1&scope=openid" },
            path: "/api/auth/oauth2/consent",
        });

        expect(refused?.outcome).toBe("failure");
        expect(granted?.outcome).toBe("success");
        expect(granted?.detail).toMatchObject({ clientId: "app_1" });
    });

    it("names the client a refresh grant refreshed for, as a code exchange does", () => {
        expect.assertions(2);

        const refresh = buildAuditEntry({
            body: { client_id: "app_2", grant_type: "refresh_token" },
            path: "/api/auth/oauth2/token",
        });

        expect(refresh?.event).toBe("token-refresh");
        expect(refresh?.detail).toMatchObject({ clientId: "app_2" });
    });

    it("names a newly registered OAuth client from its response", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({
            body: { client_name: "Portal" },
            context: { returned: { client_id: "app_3", client_name: "Portal" } },
            path: "/api/auth/oauth2/create-client",
        });

        expect(entry?.detail).toMatchObject({ clientId: "app_3" });
    });
});
