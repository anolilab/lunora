import { describe, expect, it } from "vitest";

import { buildAuditEntry } from "../src/audit-hooks";

describe("resource and consent rows name what they act on, without the secrets around it", () => {
    it("keeps the origin and path of a resource URI and drops its credentials and query", () => {
        expect.assertions(2);

        const entry = buildAuditEntry({
            body: { identifier: "https://user:pa55@api.example.com/v1?access_token=s3cret" },
            method: "POST",
            path: "/api/auth/admin/oauth2/resources",
        });

        expect(entry?.detail).toMatchObject({ resourceIdentifier: "https://api.example.com/v1" });
        expect(JSON.stringify(entry?.detail)).not.toMatch(/pa55|s3cret/u);
    });

    it("names the consent an update or a revoke acts on", () => {
        expect.assertions(2);

        const update = buildAuditEntry({ body: { id: "consent_1", update: { scopes: ["openid"] } }, path: "/api/auth/oauth2/update-consent" });
        const revoke = buildAuditEntry({ body: { id: "consent_2" }, path: "/api/auth/oauth2/delete-consent" });

        expect(update?.detail).toMatchObject({ consentId: "consent_1" });
        expect(revoke?.detail).toMatchObject({ consentId: "consent_2" });
    });

    it("keeps a malformed resource identifier's path, and never the query after it", () => {
        expect.assertions(2);

        const entry = buildAuditEntry({
            body: { identifier: "https://resource.example:invalid/?access_token=secret" },
            method: "POST",
            path: "/api/auth/admin/oauth2/resources",
        });

        expect(entry?.detail).toMatchObject({ resourceIdentifier: "https://resource.example:invalid/" });
        expect(JSON.stringify(entry?.detail)).not.toContain("secret");
    });

    it("keeps a non-web resource identifier as written", () => {
        expect.assertions(2);

        const service = buildAuditEntry({ body: { identifier: "api://billing" }, method: "POST", path: "/api/auth/admin/oauth2/resources" });
        const urn = buildAuditEntry({ body: { identifier: "urn:example:api" }, method: "POST", path: "/api/auth/admin/oauth2/resources" });

        expect(service?.detail).toMatchObject({ resourceIdentifier: "api://billing" });
        expect(urn?.detail).toMatchObject({ resourceIdentifier: "urn:example:api" });
    });

    it("records an unauthenticated token request, and drops an email sent where its client id belongs", () => {
        expect.assertions(2);

        const entry = buildAuditEntry({
            body: { client_id: "alice@example.com", code: "c", grant_type: "authorization_code" },
            path: "/api/auth/oauth2/token",
        });

        expect(entry?.event).toBe("oauth-token-issue");
        expect(entry?.detail).not.toHaveProperty("clientId");
    });

    it("keeps the slash that ends a real path, and drops only the query after it", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({
            body: { identifier: "https://api.example.com/v1/?access_token=secret" },
            method: "POST",
            path: "/api/auth/admin/oauth2/resources",
        });

        expect(entry?.detail).toMatchObject({ resourceIdentifier: "https://api.example.com/v1/" });
    });

    it("keeps the path of a resource whose URI carries an @ in it", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({
            body: { identifier: "https://api.example.com/users/@me" },
            method: "POST",
            path: "/api/auth/admin/oauth2/resources",
        });

        expect(entry?.detail).toMatchObject({ resourceIdentifier: "https://api.example.com/users/@me" });
    });

    it("keeps no part of the credentials of a malformed resource URI", () => {
        expect.assertions(2);

        const entry = buildAuditEntry({
            body: { identifier: "https://alice:s3cretpass@resource.example:bad/path" },
            method: "POST",
            path: "/api/auth/admin/oauth2/resources",
        });

        expect(JSON.stringify(entry?.detail ?? {})).not.toContain("s3cretpass");
        expect(JSON.stringify(entry?.detail ?? {})).not.toContain("alice");
    });
});
