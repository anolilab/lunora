import { describe, expect, it } from "vitest";

import { LunoraPaymentError } from "../src/errors";
import {
    addMoney,
    allocateMoney,
    compareMoney,
    formatMoney,
    fromMoneyJSON,
    isZeroDecimalCurrency,
    money,
    subtractMoney,
    toMoneyJSON,
    zeroMoney,
} from "../src/money";

describe("money", () => {
    it("constructs from number and bigint and uppercases the currency", () => {
        expect.assertions(3);

        expect(money(500, "usd")).toEqual({ currency: "USD", minorUnits: 500n });
        expect(money(500n, "EUR")).toEqual({ currency: "EUR", minorUnits: 500n });
        expect(zeroMoney("gbp")).toEqual({ currency: "GBP", minorUnits: 0n });
    });

    it("rejects fractional and non-finite amounts instead of truncating (regression)", () => {
        expect.assertions(4);

        // `money(19.99, "USD")` used to silently truncate to 19 minor units — a 99% under-charge.
        expect(() => money(19.99, "USD")).toThrow(LunoraPaymentError);

        let thrown: unknown;

        try {
            money(19.99, "USD");
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toMatchObject({ code: "VALIDATION_ERROR" });

        // NaN used to throw a bare RangeError from BigInt(); it must be a LunoraPaymentError.
        expect(() => money(Number.NaN, "USD")).toThrow(LunoraPaymentError);
        // Negative integers stay legal — refund math needs them.
        expect(money(-500, "USD")).toEqual({ currency: "USD", minorUnits: -500n });
    });

    it("adds and subtracts same-currency amounts", () => {
        expect.assertions(2);

        expect(addMoney(money(500, "USD"), money(250, "USD")).minorUnits).toBe(750n);
        expect(subtractMoney(money(500, "USD"), money(250, "USD")).minorUnits).toBe(250n);
    });

    it("rejects mixing currencies", () => {
        expect.assertions(1);

        expect(() => addMoney(money(1, "USD"), money(1, "EUR"))).toThrow(LunoraPaymentError);
    });

    it("compares amounts", () => {
        expect.assertions(3);

        expect(compareMoney(money(1, "USD"), money(2, "USD"))).toBe(-1);
        expect(compareMoney(money(2, "USD"), money(2, "USD"))).toBe(0);
        expect(compareMoney(money(3, "USD"), money(2, "USD"))).toBe(1);
    });

    it("formats money for display, honoring the currency's minor units", () => {
        expect.assertions(3);

        expect(formatMoney(money(1999, "USD"))).toBe("$19.99");
        // JPY is zero-decimal — 500 minor units is ¥500, not ¥5.00.
        expect(formatMoney(money(500, "JPY"))).toBe("¥500");
        // A malformed currency code degrades gracefully instead of throwing (Intl raises RangeError).
        expect(formatMoney(money(1000, "US"))).toBe("10.00 US");
    });

    it("flags zero-decimal currencies", () => {
        expect.assertions(2);

        expect(isZeroDecimalCurrency("JPY")).toBe(true);
        expect(isZeroDecimalCurrency("usd")).toBe(false);
    });

    it("allocates an amount across ratios, remainder and all", () => {
        expect.assertions(2);

        const parts = allocateMoney(money(1000, "USD"), [60n, 40n]);

        expect(parts.map((part) => part.minorUnits)).toEqual([600n, 400n]);

        // A non-divisible split still sums back to the original (remainder distributed).
        const thirds = allocateMoney(money(1000, "USD"), [1n, 1n, 1n]);

        expect(thirds.reduce((total, part) => total + part.minorUnits, 0n)).toBe(1000n);
    });

    it("distributes the remainder to the earliest parts, not the last", () => {
        expect.assertions(3);

        // WHICH part absorbs the extra minor unit is the property, not just the sum: seat/proration
        // math bills a specific member for it. Floor-division with the remainder dumped on the last
        // part sums identically while charging the wrong member.
        expect(allocateMoney(money(1000, "USD"), [1n, 1n, 1n]).map((part) => part.minorUnits)).toStrictEqual([334n, 333n, 333n]);
        // Two spare units go to the first two parts, in order.
        expect(allocateMoney(money(1000, "USD"), [1n, 1n, 1n, 1n, 1n, 1n]).map((part) => part.minorUnits)).toStrictEqual([167n, 167n, 167n, 167n, 166n, 166n]);
        // Uneven ratios: the remainder still lands on the earliest part.
        expect(allocateMoney(money(1000, "USD"), [3n, 2n, 1n]).map((part) => part.minorUnits)).toStrictEqual([501n, 333n, 166n]);
    });

    it("honors three-decimal currencies (KWD/BHD/…), which default to two", () => {
        expect.assertions(4);

        // Intl separates the code from the amount with U+00A0; normalise so the assertion pins the digits.
        const formatted = (minorUnits: number, currency: string): string => formatMoney(money(minorUnits, currency)).replaceAll("\u00A0", " ");

        // 1000 minor units of KWD is 1.000 dinar, not 10.00 — treating it as two-decimal makes every
        // Gulf-currency amount wrong by a factor of ten.
        expect(formatted(1000, "KWD")).toBe("KWD 1.000");
        expect(formatted(1000, "BHD")).toBe("BHD 1.000");
        expect(formatted(1234, "JOD")).toBe("JOD 1.234");
        // Still not zero-decimal.
        expect(isZeroDecimalCurrency("KWD")).toBe(false);
    });

    it("round-trips the JSON wire form without precision loss", () => {
        expect.assertions(2);

        const big = money(123_456_789_012_345n, "USD");

        expect(toMoneyJSON(big).minorUnits).toBe("123456789012345");
        expect(fromMoneyJSON(toMoneyJSON(big))).toEqual(big);
    });
});
