import { describe, expect, it } from "vitest";

import { CirrusPaymentError } from "../src/errors";
import { addMoney, compareMoney, fromMoneyJSON, isZeroDecimalCurrency, money, subtractMoney, toMoneyJSON, zeroMoney } from "../src/money";

describe("money", () => {
    it("constructs from number and bigint and uppercases the currency", () => {
        expect(money(500, "usd")).toEqual({ currency: "USD", minorUnits: 500n });
        expect(money(500n, "EUR")).toEqual({ currency: "EUR", minorUnits: 500n });
        expect(zeroMoney("gbp")).toEqual({ currency: "GBP", minorUnits: 0n });
    });

    it("adds and subtracts same-currency amounts", () => {
        expect(addMoney(money(500, "USD"), money(250, "USD")).minorUnits).toBe(750n);
        expect(subtractMoney(money(500, "USD"), money(250, "USD")).minorUnits).toBe(250n);
    });

    it("rejects mixing currencies", () => {
        expect(() => addMoney(money(1, "USD"), money(1, "EUR"))).toThrow(CirrusPaymentError);
    });

    it("compares amounts", () => {
        expect(compareMoney(money(1, "USD"), money(2, "USD"))).toBe(-1);
        expect(compareMoney(money(2, "USD"), money(2, "USD"))).toBe(0);
        expect(compareMoney(money(3, "USD"), money(2, "USD"))).toBe(1);
    });

    it("flags zero-decimal currencies", () => {
        expect(isZeroDecimalCurrency("JPY")).toBe(true);
        expect(isZeroDecimalCurrency("usd")).toBe(false);
    });

    it("round-trips the JSON wire form without precision loss", () => {
        const big = money(123_456_789_012_345n, "USD");

        expect(toMoneyJSON(big).minorUnits).toBe("123456789012345");
        expect(fromMoneyJSON(toMoneyJSON(big))).toEqual(big);
    });
});
