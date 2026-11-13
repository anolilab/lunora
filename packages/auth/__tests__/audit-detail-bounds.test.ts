import { describe, expect, it } from "vitest";

import { buildAuditEntry } from "../src/audit-hooks";

/** Ids copied from a request are bounded, since a failed request is still written to the trail. */
describe("audit detail ids are bounded", () => {
    it("cuts an oversized key id to the detail limit rather than copying it whole", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({ body: { keyId: "k".repeat(10_000) }, path: "/api/auth/api-key/delete" });

        expect(entry?.detail).toMatchObject({ keyId: "k".repeat(256) });
    });

    it("cuts an oversized user id named in an admin request the same way", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({ body: { userId: "u".repeat(10_000) }, path: "/api/auth/admin/ban-user" });

        expect(entry?.detail).toMatchObject({ targetUserId: "u".repeat(256) });
    });
});
