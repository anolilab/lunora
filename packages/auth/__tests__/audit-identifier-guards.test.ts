import { describe, expect, it } from "vitest";

import { buildAuditEntry } from "../src/audit-hooks";

/** An identifier that is really an email, or a URL with credentials, is never copied into the trail. */
describe("audit ids never carry an email", () => {
    it("drops an email sent as a key id, and still records the row it belongs to", () => {
        expect.assertions(2);

        const entry = buildAuditEntry({ body: { keyId: "alice@example.com" }, path: "/api/auth/api-key/delete" });

        expect(entry?.event).toBe("api-key-delete");
        expect(entry?.detail).not.toHaveProperty("keyId");
    });

    it("drops an email named as a user id by an admin request", () => {
        expect.assertions(2);

        const entry = buildAuditEntry({ body: { userId: "ada@example.com" }, path: "/api/auth/admin/ban-user" });

        expect(entry?.event).toBe("admin-user-ban");
        expect(entry?.detail).not.toHaveProperty("targetUserId");
    });
});
