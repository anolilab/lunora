import { describe, expect, it } from "vitest";

import { addCalendarMonths, dueAt, extendedDueAt } from "../src/deadlines";

const utc = (iso: string): Date => new Date(iso);

describe(addCalendarMonths, () => {
    it("keeps the same day in the next month", () => {
        expect(addCalendarMonths(utc("2026-04-10T09:30:00.000Z"), 1).toISOString()).toBe("2026-05-10T09:30:00.000Z");
    });

    it("clamps 31 January to 28 February in a common year", () => {
        expect(addCalendarMonths(utc("2027-01-31T00:00:00.000Z"), 1).toISOString()).toBe("2027-02-28T00:00:00.000Z");
    });

    it("clamps 31 January to 29 February in a leap year", () => {
        expect(addCalendarMonths(utc("2028-01-31T00:00:00.000Z"), 1).toISOString()).toBe("2028-02-29T00:00:00.000Z");
    });

    it("clamps 31 March to 30 April", () => {
        expect(addCalendarMonths(utc("2026-03-31T00:00:00.000Z"), 1).toISOString()).toBe("2026-04-30T00:00:00.000Z");
    });

    it("rolls the year over", () => {
        expect(addCalendarMonths(utc("2026-11-15T00:00:00.000Z"), 3).toISOString()).toBe("2027-02-15T00:00:00.000Z");
    });
});

describe("the Art. 12(3) deadlines", () => {
    it("sets dueAt one calendar month after receipt, not after identity verification", () => {
        expect(dueAt(utc("2026-01-31T12:00:00.000Z")).toISOString()).toBe("2026-02-28T12:00:00.000Z");
    });

    it("sets the extended deadline three months after receipt", () => {
        expect(extendedDueAt(utc("2026-01-31T12:00:00.000Z")).toISOString()).toBe("2026-04-30T12:00:00.000Z");
    });
});
