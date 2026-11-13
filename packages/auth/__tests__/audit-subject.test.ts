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

describe("the actor of a revoke is the account that made it", () => {
    it("names the request's account, not one a revoke left in the new session", () => {
        expect.assertions(2);

        const entry = buildAuditEntry({
            context: {
                newSession: { session: { userId: "user_b" }, user: { id: "user_b" } },
                session: { session: { userId: "user_a" }, user: { id: "user_a" } },
            },
            path: "/api/auth/multi-session/revoke",
        });

        expect(entry?.event).toBe("session-revoke");
        expect(entry?.actorId).toBe("user_a");
    });
});

describe("a session switch and an impersonated revoke are made by the request's session", () => {
    it("names the account that switched, not the one it switched to", () => {
        expect.assertions(2);

        const entry = buildAuditEntry({
            context: {
                newSession: { session: { userId: "user_b" }, user: { email: "b@example.com", id: "user_b" } },
                session: { session: { userId: "user_a" }, user: { email: "a@example.com", id: "user_a" } },
            },
            path: "/api/auth/multi-session/set-active",
        });

        expect(entry?.actorId).toBe("user_a");
        expect(entry?.actorEmail).toBe("a@example.com");
    });

    it("names the impersonated account a revoke was made from, when the revoke leaves an ordinary session", () => {
        expect.assertions(2);

        const entry = buildAuditEntry({
            context: {
                newSession: { session: { userId: "user_c" }, user: { id: "user_c" } },
                session: { session: { impersonatedBy: "admin_a", userId: "user_b" }, user: { id: "user_b" } },
            },
            path: "/api/auth/revoke-session",
        });

        expect(entry?.actorId).toBe("admin_a");
        expect(entry?.detail).toMatchObject({ targetUserId: "user_b" });
    });
});
