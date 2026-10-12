import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { PrivacyRequestRow, PrivacyRequestStatus } from "../../../src/features/privacy/privacy-requests-source";
import { isPrivacyRequestOverdue, PRIVACY_REQUEST_STATUSES } from "../../../src/features/privacy/privacy-requests-source";

/** The package's lifecycle file, which the Studio's status union mirrors. */
const LIFECYCLE_SOURCE = resolve(__dirname, "../../../../privacy/src/lifecycle.ts");

/** Compile-time check: every member of the status union is listed in the runtime array. */
type UnlistedStatus = Exclude<PrivacyRequestStatus, (typeof PRIVACY_REQUEST_STATUSES)[number]>;
const everyStatusListed: [UnlistedStatus] extends [never] ? true : never = true;

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

describe("privacy request status mirror", () => {
    it("lists every status the package's RequestStatus declares", () => {
        expect.assertions(2);

        const source = readFileSync(LIFECYCLE_SOURCE, "utf8");
        const match = /type RequestStatus = ([^;]+);/.exec(source);

        expect(match?.[1]).toBeDefined();

        const packageStatuses = [...(match?.[1] ?? "").matchAll(/"([a-z]+)"/g)].map((m) => m[1] ?? "").toSorted((a, b) => (a < b ? -1 : 1));

        expect([...PRIVACY_REQUEST_STATUSES].toSorted((a, b) => (a < b ? -1 : 1))).toEqual(packageStatuses);
    });

    it("types every listed status as a valid row status", () => {
        expect.assertions(1);

        expect(everyStatusListed).toBe(true);
    });
});
