import { describe, expect, it } from "vitest";

import { isOverdue } from "../../../../../shared/privacy-deadlines";
import type { PrivacyRequestRow } from "../../../src/features/privacy/privacy-requests-source";
import { isPrivacyRequestOverdue, PRIVACY_REQUEST_STATUSES, privacyRequestDeadlines } from "../../../src/features/privacy/privacy-requests-source";

const RECEIVED = Date.parse("2026-01-31T12:00:00Z");
const DAY = 86_400_000;

const row = (overrides: Partial<PrivacyRequestRow> = {}): PrivacyRequestRow => {
    return {
        id: "req_1",
        receivedAt: RECEIVED,
        status: "received",
        subjectId: "user_1",
        type: "export",
        ...overrides,
    };
};

describe("privacyRequestDeadlines", () => {
    it("computes the calendar-month deadlines from the receipt date", () => {
        expect.assertions(2);

        // 31 January plus one month is the last day of February; plus three months is 30 April.
        expect(privacyRequestDeadlines(row())).toStrictEqual({ dueAt: Date.parse("2026-02-28T12:00:00Z"), extendedDueAt: undefined });
        expect(privacyRequestDeadlines(row({ extendedDueAt: 0 })).extendedDueAt).toBe(Date.parse("2026-04-30T12:00:00Z"));
    });
});

describe("isPrivacyRequestOverdue", () => {
    const DUE = Date.parse("2026-02-28T12:00:00Z");

    it("is overdue once the one-month deadline has passed, and not before", () => {
        expect.assertions(2);

        expect(isPrivacyRequestOverdue(row(), DUE + 1)).toBe(true);
        expect(isPrivacyRequestOverdue(row(), DUE)).toBe(false);
    });

    it("judges an extended request against the computed extended date, not the stored one", () => {
        expect.assertions(2);

        // A stored extension date that drifted from the rule does not move the deadline.
        const extended = row({ extendedDueAt: DUE - DAY });

        expect(isPrivacyRequestOverdue(extended, DUE + DAY)).toBe(false);
        expect(isPrivacyRequestOverdue(extended, Date.parse("2026-04-30T12:00:00Z") + 1)).toBe(true);
    });

    it("falls back to the original deadline when extendedDueAt is null", () => {
        expect.assertions(1);

        expect(isPrivacyRequestOverdue(row({ extendedDueAt: null }), DUE + 1)).toBe(true);
    });

    it("agrees with the shared rule the privacy package's sweep uses, for every status", () => {
        expect.assertions(8);

        const late = DUE + 30 * DAY;

        for (const status of PRIVACY_REQUEST_STATUSES) {
            expect(isPrivacyRequestOverdue(row({ status }), late)).toBe(isOverdue({ receivedAt: new Date(RECEIVED), status }, new Date(late)));
        }
    });
});
