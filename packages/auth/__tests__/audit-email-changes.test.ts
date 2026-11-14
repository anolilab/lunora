import { describe, expect, it } from "vitest";

import { buildAuditEntry } from "../src/audit-hooks";

const CHANGE_EMAIL = "/api/auth/change-email";

const session = {
    session: { userId: "user_1" },
    user: { email: "old@example.com", id: "user_1" },
};

describe("an email change is recorded as completed only when the address changed", () => {
    it("records an immediate change as email-change, attributed to the signed-in account's old address", () => {
        expect.assertions(3);

        const entry = buildAuditEntry({
            body: { newEmail: "New@Example.com" },
            context: {
                newSession: { session: { userId: "user_1" }, user: { email: "new@example.com", id: "user_1" } },
                session,
            },
            path: CHANGE_EMAIL,
        });

        expect(entry?.event).toBe("email-change");
        expect(entry?.actorEmail).toBe("old@example.com");
        expect(entry?.actorId).toBe("user_1");
    });

    it("keeps a request that only sends a link as email-change-request", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({
            body: { newEmail: "new@example.com" },
            context: { returned: { status: true }, session },
            path: CHANGE_EMAIL,
        });

        expect(entry?.event).toBe("email-change-request");
    });

    it("keeps a taken address as a request, even though the response reads as a change", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({
            body: { newEmail: "taken@example.com" },
            context: { returned: { status: true }, session },
            path: CHANGE_EMAIL,
        });

        expect(entry?.event).toBe("email-change-request");
    });
});

describe("a send-verification-otp call is a password reset only for the forget-password type", () => {
    const path = "/api/auth/email-otp/send-verification-otp";

    it("records a reset code as a password-reset-request", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({ body: { email: "ada@example.com", type: "forget-password" }, path });

        expect(entry?.event).toBe("password-reset-request");
    });

    it.each(["sign-in", "email-verification"])("records no row for a %s code", (type) => {
        expect.assertions(1);

        expect(buildAuditEntry({ body: { email: "ada@example.com", type }, path })).toBeUndefined();
    });
});
