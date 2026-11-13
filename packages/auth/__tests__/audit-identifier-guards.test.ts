import { describe, expect, it } from "vitest";

import { buildAuditEntry } from "../src/audit-hooks";

/** An identifier that is really an email, or a URL with credentials, is never copied into the trail. */
describe("audit ids never carry an email", () => {
    it("drops an email sent where an OAuth client id belongs, on an unauthenticated token request", () => {
        expect.assertions(2);

        const entry = buildAuditEntry({
            body: { client_id: "alice@example.com", grant_type: "authorization_code", code: "c" },
            path: "/api/auth/oauth2/token",
        });

        expect(entry?.detail).not.toHaveProperty("clientId");
        expect(JSON.stringify(entry?.detail)).not.toContain("alice@example.com");
    });

    it("drops an email named as a user id by an admin request", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({ body: { userId: "ada@example.com" }, path: "/api/auth/admin/ban-user" });

        expect(entry?.detail).not.toHaveProperty("targetUserId");
    });
});
