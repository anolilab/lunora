import { describe, expect, it } from "vitest";

import { isOverdue } from "../../../../../shared/privacy-deadlines";
import { REQUEST_STATUSES } from "../../../../../shared/privacy-request-status";
import type { PrivacyRequestRow } from "../../../src/features/privacy/privacy-requests-source";
import { isPrivacyRequestOverdue } from "../../../src/features/privacy/privacy-requests-source";

const NOW = Date.parse("2026-10-11T00:00:00Z");
const DAY = 86_400_000;

const row = (overrides: Partial<PrivacyRequestRow> = {}): PrivacyRequestRow => {
    return {
        dueAt: NOW + DAY,
        id: "req_1",
        receivedAt: NOW - DAY,
        status: "received",
        subjectId: "user_1",
        type: "export",
        ...overrides,
    };
};

describe("isPrivacyRequestOverdue", () => {
    it("is overdue once the stored due date has passed, and not before", () => {
        expect.assertions(2);

        expect(isPrivacyRequestOverdue(row({ dueAt: NOW - 1 }), NOW)).toBe(true);
        expect(isPrivacyRequestOverdue(row({ dueAt: NOW + 1 }), NOW)).toBe(false);
    });

    it("judges an extended request against the extended date, not the original", () => {
        expect.assertions(2);

        const extended = row({ dueAt: NOW - DAY, extendedDueAt: NOW + DAY });

        expect(isPrivacyRequestOverdue(extended, NOW)).toBe(false);
        expect(isPrivacyRequestOverdue({ ...extended, extendedDueAt: NOW - 1 }, NOW)).toBe(true);
    });

    it("falls back to the original due date when extendedDueAt is null", () => {
        expect.assertions(1);

        expect(isPrivacyRequestOverdue(row({ dueAt: NOW - 1, extendedDueAt: null }), NOW)).toBe(true);
    });

    it("never flags a ready export or a finished request, since the answer was given", () => {
        expect.assertions(4);

        for (const status of ["ready", "completed", "cancelled", "expired"] as const) {
            expect(isPrivacyRequestOverdue(row({ dueAt: NOW - DAY, status }), NOW)).toBe(false);
        }
    });

    it("agrees with the shared rule the privacy package's sweep uses, for every status", () => {
        expect.assertions(8);

        for (const status of REQUEST_STATUSES) {
            expect(isPrivacyRequestOverdue(row({ dueAt: NOW - DAY, status }), NOW)).toBe(isOverdue({ dueAt: new Date(NOW - DAY), status }, new Date(NOW)));
        }
    });
});
