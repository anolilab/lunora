import { describe, expect, it } from "vitest";

import { buildAuditEntry } from "../src/audit-hooks";

/** Ids copied from a request are bounded, since a failed request is still written to the trail. */
describe("audit detail ids are bounded", () => {
    it("keeps an oversized key id within the detail limit, cut and marked with a hash of the whole", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({ body: { keyId: "k".repeat(10_000) }, path: "/api/auth/api-key/delete" });

        expect(entry?.detail).toMatchObject({ keyId: expect.stringMatching(/^k{241}~[0-9a-f]{14}$/) });
    });

    it("keeps two oversized ids that share a prefix apart", () => {
        expect.assertions(1);

        const shared = "k".repeat(300);
        const first = buildAuditEntry({ body: { keyId: `${shared}1` }, path: "/api/auth/api-key/delete" });
        const second = buildAuditEntry({ body: { keyId: `${shared}2` }, path: "/api/auth/api-key/delete" });

        expect(first?.detail?.["keyId"]).not.toBe(second?.detail?.["keyId"]);
    });

    it("keeps an oversized user id named in an admin request the same way", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({ body: { userId: "u".repeat(10_000) }, path: "/api/auth/admin/ban-user" });

        expect(entry?.detail).toMatchObject({ targetUserId: expect.stringMatching(/^u{241}~[0-9a-f]{14}$/) });
    });
});
