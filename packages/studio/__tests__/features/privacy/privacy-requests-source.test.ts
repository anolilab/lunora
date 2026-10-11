import { describe, expect, it } from "vitest";

import type { PrivacyRequestRow } from "../../../src/features/privacy/privacy-requests-source";
import { isPrivacyRequestOverdue } from "../../../src/features/privacy/privacy-requests-source";

const NOW = Date.parse("2026-10-11T00:00:00Z");
const DAY = 86_400_000;

const row = (overrides: Partial<PrivacyRequestRow> = {}): PrivacyRequestRow => {
    return {
        dueAt: NOW + DAY,
        id: "req_1",
        receivedAt: NOW - DAY,
        status: "open",
        subjectId: "user_1",
        type: "export",
        ...overrides,
    };
};

describe("isPrivacyRequestOverdue", () => {
    it("is overdue once the original due date has passed", () => {
        expect.assertions(1);

        expect(isPrivacyRequestOverdue(row({ dueAt: NOW - 1 }), NOW)).toBe(true);
    });

    it("is not overdue while the due date is still in the future", () => {
        expect.assertions(1);

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
});
