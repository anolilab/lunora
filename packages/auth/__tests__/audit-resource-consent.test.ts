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
});
