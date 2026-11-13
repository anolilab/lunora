import { describe, expect, it } from "vitest";

import { buildAuditEntry } from "../src/audit-hooks";

describe("a phone code records a sign-in only when it signs someone in", () => {
    const path = "/api/auth/phone-number/verify";

    it("records a sign-in when the code returns a session token", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({ body: { code: "123456" }, context: { returned: { token: "sess_1", status: true } }, path });

        expect(entry?.event).toBe("sign-in");
    });

    it("records a verification, not a sign-in, when sessions are disabled and the response has no token", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({ body: { code: "123456" }, context: { returned: { token: null, status: true } }, path });

        expect(entry?.event).toBe("phone-verification");
    });
});
