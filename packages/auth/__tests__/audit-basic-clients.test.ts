import { describe, expect, it } from "vitest";

import { buildAuditEntry } from "../src/audit-hooks";

/**
 * Rows for an organization change that names no organization, a role named by its name, and an OAuth client that
 * authenticates with a Basic credential rather than naming itself in the body.
 */
describe("audit rows name the organization, role and client their request acts on", () => {
    const activeInA = { session: { activeOrganizationId: "org_a" } };

    it("names the active organization when an organization update does not name one", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({
            body: { name: "Acme 2" },
            context: { session: activeInA },
            method: "POST",
            path: "/api/auth/organization/update",
        });

        expect(entry?.detail).toMatchObject({ organizationId: "org_a" });
    });

    it("names the organization an invitation was created in from its response, when the request names none", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({
            body: { email: "ada@example.com", role: "member" },
            context: { returned: { id: "inv_1", organizationId: "org_b" } },
            method: "POST",
            path: "/api/auth/organization/invite-member",
        });

        expect(entry?.detail).toMatchObject({ organizationId: "org_b", invitationId: "inv_1" });
    });

    it("names a role a delete addresses by its name", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({ body: { roleName: "editor" }, method: "POST", path: "/api/auth/organization/delete-role" });

        expect(entry?.detail).toMatchObject({ roleName: "editor" });
    });

    it("names the client that authenticates with a Basic credential on a code exchange, and never copies its secret", () => {
        expect.assertions(2);

        const credential = Buffer.from("app_9:super-secret-value").toString("base64");
        const entry = buildAuditEntry({
            body: { grant_type: "authorization_code", code: "abc" },
            headers: new Headers({ authorization: `Basic ${credential}` }),
            method: "POST",
            path: "/api/auth/oauth2/token",
        });

        expect(entry?.detail).toMatchObject({ clientId: "app_9" });
        expect(JSON.stringify(entry?.detail)).not.toContain("super-secret-value");
    });

    it("names the client a refresh grant authenticated as with a Basic credential", () => {
        expect.assertions(1);

        const credential = Buffer.from("app_10:secret").toString("base64");
        const entry = buildAuditEntry({
            body: { grant_type: "refresh_token", refresh_token: "r" },
            headers: new Headers({ authorization: `Basic ${credential}` }),
            method: "POST",
            path: "/api/auth/oauth2/token",
        });

        expect(entry?.detail).toMatchObject({ clientId: "app_10" });
    });
});

describe("audit rows never read a secret as an id", () => {
    it("names no client from a Basic credential that carries no client id, and copies nothing of it", () => {
        expect.assertions(2);

        const credential = Buffer.from("only-a-secret-value").toString("base64");
        const entry = buildAuditEntry({
            headers: new Headers({ authorization: `Basic ${credential}` }),
            method: "POST",
            path: "/api/auth/oauth2/token",
        });

        expect(entry?.detail).not.toHaveProperty("clientId");
        expect(JSON.stringify(entry?.detail)).not.toContain("only-a-secret-value");
    });

    it("never copies an email into the member id, even when it arrives in that field", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({
            body: { memberId: "ada@example.com" },
            method: "POST",
            path: "/api/auth/organization/remove-member",
        });

        expect(entry?.detail).not.toHaveProperty("memberId");
    });

    it("names the organization a switch by slug moved to, from the organization it answers with", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({
            body: { organizationSlug: "acme" },
            context: { returned: { id: "org_acme", slug: "acme" } },
            method: "POST",
            path: "/api/auth/organization/set-active",
        });

        expect(entry?.detail).toMatchObject({ organizationId: "org_acme" });
    });
});
