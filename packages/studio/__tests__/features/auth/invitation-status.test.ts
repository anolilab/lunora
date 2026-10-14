import { describe, expect, it } from "vitest";

import { invitationStatus } from "../../../src/features/auth/invitation-status";

const NOW = Date.parse("2026-01-02T00:00:00Z");
const HOUR_MS = 60 * 60 * 1000;

describe(invitationStatus, () => {
    it("calls an unaccepted invitation with time left pending", () => {
        expect.assertions(1);

        expect(invitationStatus({ acceptedAt: null, expiresAt: NOW + HOUR_MS, id: "1" }, NOW)).toBe("pending");
    });

    it("calls an unaccepted invitation past its expiry expired", () => {
        expect.assertions(2);

        expect(invitationStatus({ acceptedAt: null, expiresAt: NOW - HOUR_MS, id: "1" }, NOW)).toBe("expired");
        // Exactly at the boundary counts as expired, matching the server's `<=`.
        expect(invitationStatus({ acceptedAt: null, expiresAt: NOW, id: "1" }, NOW)).toBe("expired");
    });

    it("prefers spent over expired, so an address with an account never reads as a lapsed invitation", () => {
        expect.assertions(1);

        expect(invitationStatus({ acceptedAt: NOW - HOUR_MS, expiresAt: NOW - HOUR_MS, id: "1" }, NOW)).toBe("spent");
    });

    it("treats a row with no expiry as pending rather than expired", () => {
        expect.assertions(1);

        // An absent value is a malformed row, not proof the invitation lapsed —
        // the conservative label keeps it visible instead of aged out of the list.
        expect(invitationStatus({ id: "1" }, NOW)).toBe("pending");
    });
});
