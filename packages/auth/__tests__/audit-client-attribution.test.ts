import { describe, expect, it } from "vitest";

import { buildAuditEntry } from "../src/audit-hooks";

const basic = (user: string, password: string): Headers => {
    const credential = Buffer.from(`${user}:${password}`).toString("base64"); // secret-scanner:allow -- builds a test Basic header from placeholder values

    return new Headers({ authorization: `Basic ${credential}` });
};

describe("a token row names the client the server authenticated", () => {
    it("names the Basic client over a different client_id in the body", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({
            body: { client_id: "app_other", code: "c", grant_type: "authorization_code" },
            context: { returned: new Error("invalid_grant") },
            headers: basic("app_real", "secret"),
            path: "/api/auth/oauth2/token",
        });

        expect(entry?.detail).toMatchObject({ clientId: "app_real" });
    });

    it("names the Basic client of a refresh grant over a different client_id in the body", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({
            body: { client_id: "app_other", grant_type: "refresh_token", refresh_token: "r" },
            headers: basic("app_real", "secret"),
            path: "/api/auth/oauth2/token",
        });

        expect(entry?.detail).toMatchObject({ clientId: "app_real" });
    });

    it.each(["/api/auth/refresh-token", "/api/auth/token"])("does not read a proxy's Basic login as the client of %s", (path) => {
        expect.assertions(2);

        const entry = buildAuditEntry({ headers: basic("staging-gate", "proxy-pass"), path });

        expect(entry?.event).toBe("token-refresh");
        expect(entry?.detail).not.toHaveProperty("clientId");
    });
});

describe("a client registration names the client it created", () => {
    it("ignores a client_id the registration request carries", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({
            body: { client_id: "app_victim", client_name: "Portal" },
            context: { returned: { client_id: "app_new", client_name: "Portal" } },
            method: "POST",
            path: "/api/auth/oauth2/register",
        });

        expect(entry?.detail).toMatchObject({ clientId: "app_new" });
    });

    it("names no client for a failed registration, whatever its request carries", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({
            body: { client_id: "app_victim" },
            context: { returned: new Error("invalid_client_metadata") },
            method: "POST",
            path: "/api/auth/oauth2/register",
        });

        expect(entry?.detail).not.toHaveProperty("clientId");
    });
});

describe("a cancelled invitation names its organization", () => {
    it("reads the organization from the invitation the cancel returns", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({
            body: { invitationId: "inv_3" },
            context: { returned: { id: "inv_3", organizationId: "org_d", status: "canceled" } },
            method: "POST",
            path: "/api/auth/organization/cancel-invitation",
        });

        expect(entry?.detail).toMatchObject({ invitationId: "inv_3", organizationId: "org_d" });
    });
});
