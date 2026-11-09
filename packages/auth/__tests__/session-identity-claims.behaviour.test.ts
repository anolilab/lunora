import { describe, expect, it } from "vitest";

import { identityFromSession } from "../src/session-identity";

/**
 * App-declared user columns forwarded onto the identity. Only the names a caller
 * passes are forwarded, and only when the value is JSON-safe and present: a column
 * an older user never had (`null` or unset) is omitted, not sent as `null`, so the
 * declared validator never sees a value it did not expect. Secret-bearing columns and
 * reserved claim names are never forwarded, whatever the caller asks for.
 */

const session = (user: Record<string, unknown>) => {
    return {
        session: { expiresAt: new Date("2030-01-01T00:00:00Z") },
        user: { id: "user-1", ...user },
    };
};

describe("identityFromSession with app claims", () => {
    it("forwards the declared columns with their JSON values", () => {
        expect.hasAssertions();

        const identity = identityFromSession(
            session({ plan: "pro", seats: 5, verified: true, joinedAt: new Date("2029-02-03T04:05:06.000Z"), extra: "not declared" }),
            ["plan", "seats", "verified", "joinedAt"],
        );

        expect(identity).toStrictEqual({
            expiresAtMs: new Date("2030-01-01T00:00:00Z").getTime(),
            joinedAt: "2029-02-03T04:05:06.000Z",
            plan: "pro",
            seats: 5,
            userId: "user-1",
            verified: true,
        });
    });

    it("omits a declared column that is null, unset or an invalid date, rather than sending null", () => {
        expect.hasAssertions();

        const identity = identityFromSession(session({ department: null, plan: undefined, joinedAt: new Date("not a date") }), [
            "department",
            "plan",
            "joinedAt",
            "missing",
        ]);

        expect(identity).not.toHaveProperty("department");
        expect(identity).not.toHaveProperty("plan");
        expect(identity).not.toHaveProperty("joinedAt");
        expect(identity).not.toHaveProperty("missing");
        expect(identity?.userId).toBe("user-1");
    });

    it("never forwards a secret-bearing column, even when it is declared", () => {
        expect.hasAssertions();

        const identity = identityFromSession(session({ token: "bearer-value", refreshToken: "rt", plan: "pro" }), ["token", "refreshToken", "plan"]);

        expect(identity).not.toHaveProperty("token");
        expect(identity).not.toHaveProperty("refreshToken");
        expect(identity).toHaveProperty("plan", "pro");
    });

    it("never lets an app column fill or overwrite a reserved claim", () => {
        expect.hasAssertions();

        // `role` is unset on the session, so an app column named `role` must not supply it.
        const identity = identityFromSession(session({ role: undefined, userId: "spoofed", orgId: "spoofed", tenant: "t1" }), [
            "role",
            "userId",
            "orgId",
            "tenant",
        ]);

        expect(identity?.userId).toBe("user-1");
        expect(identity).not.toHaveProperty("role");
        expect(identity).not.toHaveProperty("orgId");
        expect(identity).toHaveProperty("tenant", "t1");
    });

    it("drops object and array values, which are not flat claims", () => {
        expect.hasAssertions();

        const identity = identityFromSession(session({ prefs: { theme: "dark" }, scopes: ["a", "b"] }), ["prefs", "scopes"]);

        expect(identity).not.toHaveProperty("prefs");
        expect(identity).not.toHaveProperty("scopes");
    });

    it("forwards nothing when no claims are declared, so the identity is unchanged", () => {
        expect.hasAssertions();

        const identity = identityFromSession(session({ plan: "pro" }));

        expect(identity).toStrictEqual({ expiresAtMs: new Date("2030-01-01T00:00:00Z").getTime(), userId: "user-1" });
    });
});
