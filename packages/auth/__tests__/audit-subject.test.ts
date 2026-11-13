import { describe, expect, it } from "vitest";

import { buildAuditEntry } from "../src/audit-hooks";

/**
 * An administrator acting through an impersonated session is the actor, and the account being impersonated is
 * the subject of every row the session writes, not only the admin-* rows.
 */
describe("impersonated sessions name the impersonated account on every row", () => {
    const impersonating = {
        context: {
            session: {
                session: { impersonatedBy: "admin_a", userId: "user_b" },
                user: { id: "user_b" },
            },
        },
    };

    it("keeps the administrator as actor and the impersonated account as target for a password change", () => {
        expect.assertions(3);

        const entry = buildAuditEntry({ ...impersonating, path: "/api/auth/change-password" });

        expect(entry?.event).toBe("password-change");
        expect(entry?.actorId).toBe("admin_a");
        expect(entry?.detail).toMatchObject({ targetUserId: "user_b" });
    });

    it("leaves the subject unset for an ordinary session", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({
            context: { session: { session: { userId: "user_c" }, user: { id: "user_c" } } },
            path: "/api/auth/change-password",
        });

        expect(entry?.detail).not.toHaveProperty("targetUserId");
    });
});

describe("an admin row with no subject names none", () => {
    it("leaves the target unset when an admin request names no user", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({ body: { role: "admin" }, path: "/api/auth/admin/set-role" });

        expect(entry?.detail).not.toHaveProperty("targetUserId");
    });
});
