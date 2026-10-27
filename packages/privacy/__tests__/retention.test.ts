import { describe, expect, it } from "vitest";

import { germany } from "../src/de";
import { retain, retainUntil } from "../src/rules";

const [books, voucher, , correspondence] = germany().retention;

describe(retainUntil, () => {
    it("runs an endOfCalendarYear period to 31 December of year plus years", () => {
        expect(retainUntil(books!, new Date("2026-04-10T00:00:00.000Z")).toISOString()).toBe("2036-12-31T23:59:59.999Z");
    });

    it("counts a receipt on 31 December as belonging to that year", () => {
        expect(retainUntil(correspondence!, new Date("2026-12-31T23:00:00.000Z")).toISOString()).toBe("2032-12-31T23:59:59.999Z");
    });

    it("runs a from-date period by calendar months", () => {
        expect(
            retainUntil(
                { citation: "test", id: "test.from", reviewRequired: false, start: "from", years: 2 },
                new Date("2026-03-15T00:00:00.000Z"),
            ).toISOString(),
        ).toBe("2028-03-15T00:00:00.000Z");
    });
});

describe("retain directive", () => {
    it("names the rule and the column its period starts from", () => {
        expect(retain("de.voucher", { from: "issuedAt" })).toStrictEqual({ from: "issuedAt", kind: "retain", rule: "de.voucher" });
    });

    it("omits the column when the period has no start column", () => {
        expect(retain("de.books")).toStrictEqual({ kind: "retain", rule: "de.books" });
    });
});

describe("the voucher period", () => {
    it("defaults to the statutory 8 years and says so in the note", () => {
        expect(voucher!.years).toBe(8);
        expect(voucher!.note).toContain("statutory 8 years");
    });
});
